import type { HardwareData } from '@/hooks/useHardware'
import type { CatalogModel } from '@/services/models/types'

/**
 * Memory-fit estimation for local models.
 *
 * This is an *estimate* and says so everywhere it is shown. It never blocks a
 * model: the only thing that proves a model runs is running it, which is what
 * the compatibility test (`modelCompatibilityTest.ts`) and its persisted result
 * (`modelEvidence.ts`) are for.
 *
 * What the previous heuristic got wrong, and why it read as too conservative:
 *
 *  - A ~2.1 GiB "reserve" was subtracted from system RAM *and again* from VRAM,
 *    so a 8 GiB card was treated as ~5.9 GiB. Drivers and compute buffers need
 *    far less than that on a dedicated GPU; the system-side reserve is for the
 *    OS and other apps and belongs on RAM only.
 *  - Anything that did not fit entirely in VRAM was "yellow", although llama.cpp
 *    runs a partially offloaded model fine (slower, not broken).
 *  - An integrated GPU's reported memory is carved out of system RAM. Adding it
 *    to RAM counted the same bytes twice (optimistic), while treating it as the
 *    only GPU budget ignored that it can grow (pessimistic). It is now one pool.
 *  - The KV cache was always 10% of the file per 4k tokens. For GQA models that
 *    overstates the cache several times. When the GGUF metadata is available the
 *    cache is computed from the architecture and the configured cache types.
 */

export type FitTier = 'green' | 'yellow' | 'red' | 'unknown'

/** Where the estimate expects the model to run, given the memory model. */
export type FitVerdict =
  /** Fits in the GPU budget (or the only pool, with headroom). */
  | 'fits'
  /** Fits across GPU + system memory: runs with part of the model on the CPU. */
  | 'fits-partial-offload'
  /** Fits on paper with under ~10% headroom; a smaller context may be needed. */
  | 'tight'
  /** Larger than the estimated budget. Not a block: the estimate can be wrong. */
  | 'exceeds'
  | 'unknown'

export type MemoryModel =
  | 'unified'
  | 'discrete-gpu'
  | 'integrated-gpu'
  | 'cpu-only'
  | 'unknown'

export type KvMethod = 'gguf-metadata' | 'file-size-heuristic' | 'none'

export type Uncertainty = 'low' | 'medium' | 'high'

export const DEFAULT_CTX_LENGTH = 8192

const GIB = 1024 ** 3
const MIB = 1024 * 1024

/** OS and other applications. Taken from system RAM only, never from VRAM. */
export const SYSTEM_RESERVE_BYTES = 2 * GIB
/** Driver, display and CUDA/Vulkan context on a dedicated GPU, per device. */
export const DISCRETE_VRAM_RESERVE_BYTES = 512 * MIB
/** macOS keeps more for itself on unified memory. */
export const UNIFIED_SYSTEM_RESERVE_BYTES = 2.5 * GIB
/** Compute buffers and the runtime itself: a floor plus a share of weights. */
export const RUNTIME_OVERHEAD_FLOOR_BYTES = 300 * MIB
export const RUNTIME_OVERHEAD_RATIO = 0.02
/** Below this share of the budget left over, the verdict is `tight`. */
const TIGHT_HEADROOM_RATIO = 0.1

/**
 * Metal's default recommended working set is about two thirds of RAM on
 * smaller machines and about three quarters on larger ones. It is a default
 * the user can raise, so exceeding it yields partial offload, not `exceeds`.
 */
export const UNIFIED_GPU_SHARE_SMALL = 0.67
export const UNIFIED_GPU_SHARE_LARGE = 0.75
const UNIFIED_LARGE_THRESHOLD_BYTES = 36 * GIB

/** Legacy file-size KV approximation, used only without GGUF metadata. */
const KV_HEURISTIC_RATIO = 0.1
const KV_BASELINE_CTX = 4096
/**
 * Above this file size the cache is a smaller share of the weights: a 70B model
 * keeps about a sixth of the cache per byte that an 8B one does, because it
 * grows with layers and KV heads, not with parameter count. The share falls with
 * the square root of the size, which stays above the real figure (so the estimate
 * remains conservative) without calling every large model too big.
 */
const KV_HEURISTIC_KNEE_BYTES = 12 * GIB

const UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 ** 2,
  mib: 1024 ** 2,
  gb: 1000 ** 3,
  gib: 1024 ** 3,
  tb: 1000 ** 4,
  tib: 1024 ** 4,
}

export function parseFileSize(input?: string | number | null): number | null {
  if (input == null) return null
  if (typeof input === 'number') {
    return Number.isFinite(input) && input >= 0 ? input : null
  }
  const trimmed = input.trim()
  if (!trimmed) return null
  const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]+)?$/)
  if (!match) return null
  const value = parseFloat(match[1])
  if (!Number.isFinite(value) || value < 0) return null
  const unitKey = (match[2] || 'b').toLowerCase()
  const multiplier = UNIT_BYTES[unitKey]
  if (multiplier === undefined) return null
  return value * multiplier
}

// MLX models are split across multiple safetensors shards; sum them to get
// the on-device weight footprint that should be fed into estimateModelFit.
export function sumMlxModelBytes(model: CatalogModel): number {
  return (model.safetensors_files ?? []).reduce(
    (acc, f) => acc + (parseFileSize(f.file_size) ?? 0),
    0
  )
}

/** The legacy approximation, kept as the no-metadata fallback. */
export function estimateKvCacheBytes(
  fileSizeBytes: number,
  ctxLength: number = DEFAULT_CTX_LENGTH
): number {
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) return 0
  const ctx = ctxLength > 0 ? ctxLength : DEFAULT_CTX_LENGTH
  const sizeFactor =
    fileSizeBytes > KV_HEURISTIC_KNEE_BYTES
      ? Math.sqrt(KV_HEURISTIC_KNEE_BYTES / fileSizeBytes)
      : 1
  return fileSizeBytes * KV_HEURISTIC_RATIO * sizeFactor * (ctx / KV_BASELINE_CTX)
}

/** The attention shape needed to size a KV cache, read from GGUF metadata. */
export interface KvArchitecture {
  layers: number
  kvHeads: number
  keyLength: number
  valueLength: number
  trainedContext?: number
  slidingWindow?: number
}

const toPositiveInt = (value: string | undefined): number | undefined => {
  if (value == null) return undefined
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Mirrors `estimate_kv_cache_internal` in the llama.cpp plugin
 * (`gguf/utils.rs`) so the two readings of a GGUF agree. Returns null when the
 * metadata lacks what is needed; the caller then falls back to the heuristic
 * and says so.
 */
export function kvArchitectureFromGguf(
  metadata: Record<string, string> | undefined | null
): KvArchitecture | null {
  if (!metadata) return null
  const arch = metadata['general.architecture']
  if (!arch) return null
  const layers = toPositiveInt(metadata[`${arch}.block_count`])
  const heads = toPositiveInt(metadata[`${arch}.attention.head_count`])
  const kvHeads =
    toPositiveInt(metadata[`${arch}.attention.head_count_kv`]) ?? heads
  if (!layers || !kvHeads) return null
  let keyLength = toPositiveInt(metadata[`${arch}.attention.key_length`])
  let valueLength = toPositiveInt(metadata[`${arch}.attention.value_length`])
  if (!keyLength || !valueLength) {
    const embedding = toPositiveInt(metadata[`${arch}.embedding_length`])
    const totalHeads = heads ?? kvHeads
    if (embedding && totalHeads) {
      const headDim = Math.floor(embedding / totalHeads)
      keyLength = keyLength ?? headDim
      valueLength = valueLength ?? headDim
    }
  }
  if (!keyLength || !valueLength) return null
  return {
    layers,
    kvHeads,
    keyLength,
    valueLength,
    trainedContext: toPositiveInt(metadata[`${arch}.context_length`]),
    slidingWindow: toPositiveInt(metadata[`${arch}.attention.sliding_window`]),
  }
}

/** Bytes per stored element for llama.cpp cache types (block size included). */
const CACHE_TYPE_BYTES: Record<string, number> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32,
  q5_1: 24 / 32,
  q5_0: 22 / 32,
  q4_1: 20 / 32,
  q4_0: 18 / 32,
  iq4_nl: 18 / 32,
}

export function cacheTypeBytes(cacheType: string | undefined): number {
  if (!cacheType) return 2
  return CACHE_TYPE_BYTES[cacheType.toLowerCase()] ?? 2
}

export function kvCacheBytesFromArchitecture(
  arch: KvArchitecture,
  ctxLength: number,
  cacheTypeK?: string,
  cacheTypeV?: string
): { bytes: number; effectiveContext: number } {
  const requested = ctxLength > 0 ? ctxLength : DEFAULT_CTX_LENGTH
  const effectiveContext = arch.trainedContext
    ? Math.min(requested, arch.trainedContext)
    : requested
  const perToken =
    arch.layers *
    arch.kvHeads *
    (arch.keyLength * cacheTypeBytes(cacheTypeK) +
      arch.valueLength * cacheTypeBytes(cacheTypeV))
  const full = perToken * effectiveContext
  if (arch.slidingWindow && arch.slidingWindow < effectiveContext) {
    // Some layers only keep the window. Without per-layer metadata the split is
    // unknown; the midpoint matches the plugin and is flagged as uncertain.
    const sliding = perToken * arch.slidingWindow
    return { bytes: (full + sliding) / 2, effectiveContext }
  }
  return { bytes: full, effectiveContext }
}

export function isAppleSilicon(hardware: HardwareData): boolean {
  return (
    hardware.os_type === 'macos' &&
    hardware.cpu.arch === 'aarch64' &&
    hardware.gpus.length === 0
  )
}

/** Vulkan reports `PhysicalDeviceType` via Debug, e.g. "IntegratedGpu". */
export function isIntegratedGpu(gpu: HardwareData['gpus'][number]): boolean {
  return /integrated/i.test(gpu.vulkan_info?.device_type ?? '')
}

function totalRamBytes(hardware: HardwareData): number {
  return (hardware.total_memory || 0) * MIB
}

export interface FitInput {
  weightsBytes: number | null
  ctxLength: number
  hardware: HardwareData
  /** From GGUF metadata; null means "not available", which widens uncertainty. */
  architecture?: KvArchitecture | null
  cacheTypeK?: string
  cacheTypeV?: string
  /** Vision projector file size when known. */
  mmprojBytes?: number
  /** llama.cpp `n_gpu_layers`: 0 forces the CPU; negative is automatic. */
  gpuLayers?: number
  /** Other models that will stay loaded alongside this one. */
  otherLoadedBytes?: number
}

export interface FitBreakdown {
  weights: number
  kvCache: number
  mmproj: number
  runtimeOverhead: number
  total: number
}

export interface FitBudgets {
  /** Memory the GPU path can use for this model. 0 when there is none. */
  gpu: number
  /** Everything the model can use across all pools, other models subtracted. */
  total: number
  /** Physical system RAM. */
  systemRam: number
  /** Sum of dedicated VRAM, 0 for unified/integrated/CPU-only. */
  dedicatedVram: number
  otherLoaded: number
}

export type FitAssumption =
  | 'kv-from-metadata'
  | 'kv-heuristic'
  | 'kv-sliding-window-midpoint'
  | 'context-capped-to-trained'
  | 'unified-gpu-working-set'
  | 'integrated-gpu-shares-ram'
  | 'discrete-vram-reserve'
  | 'system-reserve'
  | 'runtime-overhead'
  | 'cpu-only-by-setting'
  | 'other-models-loaded'
  | 'mmap-not-counted'
  | 'mmproj-unknown'

export interface FitAssessment {
  verdict: FitVerdict
  memoryModel: MemoryModel
  kvMethod: KvMethod
  effectiveContext: number
  required: FitBreakdown
  budgets: FitBudgets
  /** Budget left after the model, negative when it does not fit. */
  headroomBytes: number
  assumptions: FitAssumption[]
  uncertainty: Uncertainty
}

const UNKNOWN_BREAKDOWN: FitBreakdown = {
  weights: 0,
  kvCache: 0,
  mmproj: 0,
  runtimeOverhead: 0,
  total: 0,
}

function memoryModelOf(hardware: HardwareData): MemoryModel {
  if (totalRamBytes(hardware) <= 0) return 'unknown'
  if (isAppleSilicon(hardware)) return 'unified'
  if (hardware.gpus.length === 0) return 'cpu-only'
  const dedicated = hardware.gpus.filter(
    (g) => !isIntegratedGpu(g) && (g.total_memory || 0) > 0
  )
  if (dedicated.length > 0) return 'discrete-gpu'
  return hardware.gpus.some(isIntegratedGpu) ? 'integrated-gpu' : 'cpu-only'
}

/**
 * The structured estimate: what memory model applies, what the model needs,
 * what is available, and every assumption the numbers rest on.
 */
export function assessModelFit(input: FitInput): FitAssessment {
  const { hardware, weightsBytes } = input
  const assumptions: FitAssumption[] = []
  const memoryModel = memoryModelOf(hardware)
  const requestedCtx =
    input.ctxLength > 0 ? input.ctxLength : DEFAULT_CTX_LENGTH

  const unknown = (kvMethod: KvMethod = 'none'): FitAssessment => ({
    verdict: 'unknown',
    memoryModel,
    kvMethod,
    effectiveContext: requestedCtx,
    required: UNKNOWN_BREAKDOWN,
    budgets: {
      gpu: 0,
      total: 0,
      systemRam: totalRamBytes(hardware),
      dedicatedVram: 0,
      otherLoaded: 0,
    },
    headroomBytes: 0,
    assumptions,
    uncertainty: 'high',
  })

  if (
    weightsBytes == null ||
    !Number.isFinite(weightsBytes) ||
    weightsBytes <= 0 ||
    memoryModel === 'unknown'
  ) {
    return unknown()
  }

  // ---- What the model needs -------------------------------------------------
  let kvCache: number
  let kvMethod: KvMethod
  let effectiveContext = requestedCtx
  if (input.architecture) {
    const kv = kvCacheBytesFromArchitecture(
      input.architecture,
      requestedCtx,
      input.cacheTypeK,
      input.cacheTypeV
    )
    kvCache = kv.bytes
    effectiveContext = kv.effectiveContext
    kvMethod = 'gguf-metadata'
    assumptions.push('kv-from-metadata')
    if (effectiveContext < requestedCtx) {
      assumptions.push('context-capped-to-trained')
    }
    if (
      input.architecture.slidingWindow &&
      input.architecture.slidingWindow < effectiveContext
    ) {
      assumptions.push('kv-sliding-window-midpoint')
    }
  } else {
    kvCache = estimateKvCacheBytes(weightsBytes, requestedCtx)
    kvMethod = 'file-size-heuristic'
    assumptions.push('kv-heuristic')
  }

  const mmproj = input.mmprojBytes && input.mmprojBytes > 0 ? input.mmprojBytes : 0
  const runtimeOverhead =
    RUNTIME_OVERHEAD_FLOOR_BYTES + weightsBytes * RUNTIME_OVERHEAD_RATIO
  assumptions.push('runtime-overhead', 'mmap-not-counted')
  const required: FitBreakdown = {
    weights: weightsBytes,
    kvCache,
    mmproj,
    runtimeOverhead,
    total: weightsBytes + kvCache + mmproj + runtimeOverhead,
  }

  // ---- What is available ----------------------------------------------------
  const systemRam = totalRamBytes(hardware)
  const otherLoaded =
    input.otherLoadedBytes && input.otherLoadedBytes > 0
      ? input.otherLoadedBytes
      : 0
  if (otherLoaded > 0) assumptions.push('other-models-loaded')
  const cpuOnlyBySetting = input.gpuLayers === 0

  let gpu = 0
  let total = 0
  let dedicatedVram = 0

  switch (memoryModel) {
    case 'unified': {
      // One pool. The GPU budget is a subset of it, never added on top.
      const share =
        systemRam > UNIFIED_LARGE_THRESHOLD_BYTES
          ? UNIFIED_GPU_SHARE_LARGE
          : UNIFIED_GPU_SHARE_SMALL
      total = Math.max(0, systemRam - UNIFIED_SYSTEM_RESERVE_BYTES)
      gpu = Math.min(total, systemRam * share)
      assumptions.push('unified-gpu-working-set', 'system-reserve')
      break
    }
    case 'integrated-gpu': {
      // The iGPU's memory is system RAM. Counting it again would double it.
      total = Math.max(0, systemRam - SYSTEM_RESERVE_BYTES)
      gpu = total
      assumptions.push('integrated-gpu-shares-ram', 'system-reserve')
      break
    }
    case 'discrete-gpu': {
      const dedicated = hardware.gpus.filter((g) => !isIntegratedGpu(g))
      dedicatedVram = dedicated.reduce(
        (sum, g) => sum + (g.total_memory || 0) * MIB,
        0
      )
      gpu = dedicated.reduce(
        (sum, g) =>
          sum +
          Math.max(0, (g.total_memory || 0) * MIB - DISCRETE_VRAM_RESERVE_BYTES),
        0
      )
      total = gpu + Math.max(0, systemRam - SYSTEM_RESERVE_BYTES)
      assumptions.push('discrete-vram-reserve', 'system-reserve')
      break
    }
    case 'cpu-only':
    default: {
      total = Math.max(0, systemRam - SYSTEM_RESERVE_BYTES)
      gpu = 0
      assumptions.push('system-reserve')
    }
  }

  if (cpuOnlyBySetting && gpu > 0) {
    assumptions.push('cpu-only-by-setting')
    if (memoryModel === 'discrete-gpu') total -= gpu
    gpu = 0
  }

  // Other loaded models are placed wherever the runtime put them; that is not
  // observable here, so they come off the overall budget and the GPU budget
  // shrinks only if the rest would not fit in it.
  total = Math.max(0, total - otherLoaded)
  gpu = Math.min(gpu, total)

  const headroomBytes = total - required.total
  let verdict: FitVerdict
  if (required.total > total) {
    verdict = 'exceeds'
  } else if (headroomBytes < total * TIGHT_HEADROOM_RATIO) {
    verdict = 'tight'
  } else if (gpu > 0 && required.total > gpu) {
    verdict = 'fits-partial-offload'
  } else {
    verdict = 'fits'
  }

  let uncertainty: Uncertainty = kvMethod === 'gguf-metadata' ? 'low' : 'medium'
  if (
    assumptions.includes('kv-sliding-window-midpoint') ||
    otherLoaded > 0 ||
    memoryModel === 'integrated-gpu'
  ) {
    uncertainty = uncertainty === 'low' ? 'medium' : 'high'
  }
  // Near a boundary the verdict could flip on any of the assumptions above.
  if (Math.abs(headroomBytes) < total * TIGHT_HEADROOM_RATIO) {
    uncertainty = 'high'
  }

  return {
    verdict,
    memoryModel,
    kvMethod,
    effectiveContext,
    required,
    budgets: { gpu, total, systemRam, dedicatedVram, otherLoaded },
    headroomBytes,
    assumptions,
    uncertainty,
  }
}

export function tierForVerdict(verdict: FitVerdict): FitTier {
  switch (verdict) {
    case 'fits':
      return 'green'
    case 'fits-partial-offload':
    case 'tight':
      return 'yellow'
    case 'exceeds':
      return 'red'
    default:
      return 'unknown'
  }
}

/**
 * The colour-tier view of `assessModelFit` with only a file size to go on.
 * Kept for existing callers; new UI should use the full assessment.
 */
export function estimateModelFit(
  fileSizeBytes: number | null,
  ctxLength: number,
  hardware: HardwareData
): FitTier {
  return tierForVerdict(
    assessModelFit({ weightsBytes: fileSizeBytes, ctxLength, hardware }).verdict
  )
}
