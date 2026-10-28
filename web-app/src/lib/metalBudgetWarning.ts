import { toast } from 'sonner'
import { readGgufMetadata } from '@janhq/tauri-plugin-llamacpp-api'
import type { modelInfo } from '@janhq/core'
import type { HardwareData } from '@/hooks/useHardware'
import { i18n } from '@/i18n/react-i18next-compat'
import { formatBytes } from '@/lib/utils'
import {
  assessModelFit,
  DEFAULT_CTX_LENGTH,
  isAppleSilicon,
  kvArchitectureFromGguf,
  type FitAssessment,
  type FitInput,
} from '@/lib/modelCompatibility'

/**
 * On Apple Silicon a model larger than Metal's working set loads, then fails
 * on the first message with a Metal out-of-memory error (janhq/jan#9198). The
 * budget is `assessModelFit`'s unified GPU share: the hardware plugin does not
 * report `MTLDevice.recommendedMaxWorkingSetSize`, so it uses macOS's default
 * of about 2/3 of RAM up to 36 GB and about 3/4 above. A warning, never a
 * block: the user may have raised the limit (`iogpu.wired_limit_mb`).
 */
export function metalBudgetOverrun(
  fit: FitAssessment
): { required: number; budget: number } | null {
  if (fit.memoryModel !== 'unified' || fit.verdict === 'unknown') return null
  const budget = fit.budgets.gpu
  if (budget <= 0) return null // GPU layers set to 0: Metal is not used.
  const kvInRam = fit.assumptions.includes('kv-offload-disabled')
  const required = fit.required.total - (kvInRam ? fit.required.kvCache : 0)
  return required > budget ? { required, budget } : null
}

export function metalBudgetMessage(over: {
  required: number
  budget: number
}): string {
  const fmt = (b: number) => formatBytes(b, { decimals: 1 })
  return i18n.t('model-fit:metalBudget.warning', {
    required: fmt(over.required),
    budget: fmt(over.budget),
  })
}

type Settings = Record<string, unknown> | undefined

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/**
 * Best effort, before a llama.cpp load on Apple Silicon: shows a warning when
 * the model plus its context is estimated to exceed the Metal budget. Never
 * throws and never delays the load (callers do not await it).
 */
export async function warnIfOverMetalBudget(opts: {
  modelId: string
  hardware: HardwareData | undefined
  settings: Settings
  fetchModels: () => Promise<modelInfo[]>
}): Promise<boolean> {
  try {
    const { hardware, settings } = opts
    if (!hardware || !isAppleSilicon(hardware)) return false
    const info = (await opts.fetchModels()).find(
      (m) => m.id === opts.modelId && m.providerId === 'llamacpp'
    )
    if (!info?.sizeBytes) return false
    let architecture: FitInput['architecture'] = null
    if (info.path) {
      architecture = await readGgufMetadata(info.path)
        .then((meta) => kvArchitectureFromGguf(meta?.metadata))
        .catch(() => null)
    }
    const fit = assessModelFit({
      weightsBytes: info.sizeBytes,
      ctxLength: num(settings?.ctx_size) ?? DEFAULT_CTX_LENGTH,
      hardware,
      architecture,
      gpuLayers: num(settings?.n_gpu_layers),
      cacheTypeK: settings?.cache_type_k as string | undefined,
      cacheTypeV: settings?.cache_type_v as string | undefined,
      noKvOffload: settings?.no_kv_offload === true,
    })
    const over = metalBudgetOverrun(fit)
    if (!over) return false
    toast.warning(metalBudgetMessage(over), {
      id: `metal-budget-${opts.modelId}`,
      duration: 15000,
    })
    return true
  } catch {
    return false
  }
}
