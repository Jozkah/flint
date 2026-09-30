import type { HardwareData } from '@/hooks/useHardware'
import { parseGgufArchitecture } from '@/lib/ggufHeader'
import {
  approxWeightsBytes,
  chooseMmproj,
  getHuggingFaceGgufHeader,
  quantPreference,
  type HuggingFaceFileGroup,
} from '@/lib/huggingface'
import {
  assessModelFit,
  DEFAULT_CTX_LENGTH,
  kvArchitectureFromGguf,
  type FitAssessment,
  type FitInput,
  type FitVerdict,
  type KvArchitecture,
} from '@/lib/modelCompatibility'

/** What the fit estimate for a Hugging Face variant is computed against. */
export type FitContext = {
  hardware: HardwareData
  devices?: FitInput['devices']
  /** From the model's own GGUF header; without it the cache is estimated. */
  architecture?: KvArchitecture | null
  /** Used to size a variant whose file length the listing did not give. */
  parameterBillions?: number | null
}

export type GroupFit = FitAssessment & {
  /** True when the weights were sized from parameters, not a real file length. */
  sizeEstimated: boolean
}

/**
 * Whether a variant is expected to run here. A vision model's projector is
 * downloaded with it, so it counts against memory too.
 */
export function fitOfGroup(
  group: HuggingFaceFileGroup,
  groups: HuggingFaceFileGroup[],
  context: FitContext
): GroupFit {
  const known = group.totalSize
  const weightsBytes =
    known ?? approxWeightsBytes(context.parameterBillions ?? null, group.quantization)
  return {
    ...assessModelFit({
      weightsBytes,
      mmprojBytes: chooseMmproj(groups)?.totalSize ?? 0,
      ctxLength: DEFAULT_CTX_LENGTH,
      hardware: context.hardware,
      devices: context.devices,
      architecture: context.architecture ?? null,
    }),
    sizeEstimated: known == null && weightsBytes != null,
  }
}

function fitRank(verdict: FitVerdict): number {
  if (verdict === 'fits') return 500
  if (verdict === 'fits-partial-offload') return 400
  if (verdict === 'tight') return 300
  if (verdict === 'unknown') return 200
  return 0
}

/** The variant that runs best here: fits first, then the better quantization. */
export function bestGroup(
  groups: HuggingFaceFileGroup[],
  context: FitContext
): HuggingFaceFileGroup | undefined {
  const models = groups.filter((group) => group.kind === 'model')
  if (!models.length) return undefined
  return [...models].sort((a, b) => {
    const aScore =
      fitRank(fitOfGroup(a, groups, context).verdict) + quantPreference(a.quantization)
    const bScore =
      fitRank(fitOfGroup(b, groups, context).verdict) + quantPreference(b.quantization)
    if (aScore !== bScore) return bScore - aScore
    return (
      (a.totalSize ?? Number.MAX_SAFE_INTEGER) -
      (b.totalSize ?? Number.MAX_SAFE_INTEGER)
    )
  })[0]
}

/** One line on how firm an estimate is, for a tooltip beside the verdict. */
export function fitBasis(fit: GroupFit): string {
  const parts: string[] = []
  parts.push(
    fit.kvMethod === 'gguf-metadata'
      ? 'Context memory read from the model file.'
      : 'Context memory estimated from the file size.'
  )
  if (fit.sizeEstimated) parts.push('File size estimated from parameters.')
  if (fit.assumptions.includes('gpu-disabled-in-settings')) {
    parts.push('A GPU you turned off is not counted.')
  }
  return parts.join(' ')
}

const architectures = new Map<string, Promise<KvArchitecture | null>>()

/**
 * The attention shape of a repository, read once from the start of one of its
 * GGUF files (every quantization of a model shares it). Called only when the
 * user opens a model or expands its variants, and cached per repository.
 */
export function loadRepoArchitecture(
  repo: string,
  groups: HuggingFaceFileGroup[],
  token?: string
): Promise<KvArchitecture | null> {
  const cached = architectures.get(repo)
  if (cached) return cached
  const models = groups.filter((group) => group.kind === 'model')
  const smallest = [...models].sort(
    (a, b) => (a.totalSize ?? Infinity) - (b.totalSize ?? Infinity)
  )[0]
  if (!smallest) return Promise.resolve(null)
  const pending = getHuggingFaceGgufHeader(repo, smallest.primary.name, token)
    .then((bytes) => kvArchitectureFromGguf(parseGgufArchitecture(bytes)))
    .catch(() => {
      // Not cached: a later attempt (network back, token added) may work.
      architectures.delete(repo)
      return null
    })
  architectures.set(repo, pending)
  return pending
}
