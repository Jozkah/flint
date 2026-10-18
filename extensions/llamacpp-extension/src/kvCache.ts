/**
 * KV cache type defaults.
 *
 * The K/V cache settings default to `auto`: q8_0 roughly halves the cache
 * against f16 for almost no quality cost, but llama.cpp cannot quantize the V
 * cache without flash attention (context creation fails), and whether `auto`
 * flash attention resolves to on is only known to the engine at load time. So
 * the defaults are conservative where that is unknown, and a load that fails
 * because of them is retried once with f16.
 *
 * Anything the user set explicitly (any value other than `auto`) always wins.
 * An unset value (no setting at all) stays f16, as it always was.
 */

export const KV_CACHE_AUTO = 'auto'
export const KV_CACHE_DEFAULT_QUANT = 'q8_0'
const F16 = 'f16'

/** KV cache types that are not block-quantized. */
const UNQUANTIZED = new Set(['f32', 'f16', 'bf16'])

export interface KvCacheInput {
  cacheTypeK?: unknown
  cacheTypeV?: unknown
  /** `on`, `off` or `auto`; anything else counts as `auto`. */
  flashAttn?: unknown
  /**
   * Lowest CUDA compute capability among the GPUs that will run the model
   * (`7.5` for Turing / RTX 20xx), when known. Only used to pick defaults the
   * hardware can honour; anything the user set explicitly still wins.
   */
  computeCapability?: number
  /**
   * The model runs on the CPU backend only. `auto` then stays f16: on a Ryzen
   * 9950X3D a q8_0 K cache cost 35-45% prompt speed on Qwen3-0.6B and 5-12%
   * on Gemma-3-4B (generation equal), and q8_0 V with flash attention more.
   */
  cpuOnly?: boolean
}

/** `"7.5"` -> `7.5`; undefined for anything that is not `major.minor`. */
export function parseComputeCapability(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const m = /^\s*(\d+)\.(\d+)\s*$/.exec(raw)
  if (!m) return undefined
  return Number(m[1]) + Number(m[2]) / 10
}

/** Lowest capability across the NVIDIA GPUs in a hardware report. */
export function lowestComputeCapability(
  gpus: ReadonlyArray<{ nvidia_info?: { compute_capability?: unknown } | null }> | undefined
): number | undefined {
  let lowest: number | undefined
  for (const gpu of gpus ?? []) {
    const cc = parseComputeCapability(gpu?.nvidia_info?.compute_capability)
    if (cc !== undefined && (lowest === undefined || cc < lowest)) lowest = cc
  }
  return lowest
}

/** Flash attention in llama.cpp's CUDA backend needs Pascal (6.0) or newer. */
const FLASH_ATTN_MIN_CC = 6
/** Turing (7.5) runs it on tensor-core kernels, so `auto` reliably resolves on. */
const FLASH_ATTN_RELIABLE_CC = 7.5
/** bf16 arithmetic needs Ampere (8.0). */
const BF16_MIN_CC = 8

/**
 * The flash-attn setting to write when the user left it on `auto`: `off` for
 * a GPU too old to run it (a pre-Pascal card would otherwise fail context
 * creation), nothing to force otherwise.
 */
export function gpuFlashAttnDefault(cc: number | undefined): 'off' | undefined {
  return cc !== undefined && cc < FLASH_ATTN_MIN_CC ? 'off' : undefined
}

/** The flash-attn state to reason with: explicit setting, else what the GPU implies. */
function effectiveFlashAttn(input: KvCacheInput): unknown {
  if (input.flashAttn === 'on' || input.flashAttn === 'off') return input.flashAttn
  const cc = input.computeCapability
  if (cc === undefined) return input.flashAttn
  if (cc < FLASH_ATTN_MIN_CC) return 'off'
  if (cc >= FLASH_ATTN_RELIABLE_CC) return 'on'
  return input.flashAttn
}

export interface KvCacheTypes {
  k: string
  v: string
}

function isAuto(v: unknown): boolean {
  return v === KV_CACHE_AUTO
}

function explicitType(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && !isAuto(v) ? v : undefined
}

function isQuantized(v: string): boolean {
  return !UNQUANTIZED.has(v)
}

/**
 * K defaults to q8_0 (it needs no flash attention). V defaults to q8_0 only
 * when flash attention is explicitly on. `fallback` turns every defaulted slot
 * into f16; explicit values are kept either way, except that an explicit
 * quantized V is held at f16 under an explicit flash-attn=off, which
 * llama.cpp would refuse.
 */
export function resolveKvCacheTypes(
  input: KvCacheInput,
  opts: { fallback?: boolean } = {}
): KvCacheTypes {
  const fallback = opts.fallback === true || input.cpuOnly === true
  const flash = effectiveFlashAttn(input)
  const noBf16 =
    input.computeCapability !== undefined && input.computeCapability < BF16_MIN_CC
  let k =
    explicitType(input.cacheTypeK) ??
    (isAuto(input.cacheTypeK) && !fallback ? KV_CACHE_DEFAULT_QUANT : F16)

  let v =
    explicitType(input.cacheTypeV) ??
    (isAuto(input.cacheTypeV) && !fallback && flash === 'on'
      ? KV_CACHE_DEFAULT_QUANT
      : F16)
  if (flash === 'off' && isQuantized(v)) v = F16
  // bf16 on a pre-Ampere GPU (Turing included) has no hardware path.
  if (noBf16) {
    if (k === 'bf16') k = F16
    if (v === 'bf16') v = F16
  }
  return { k, v }
}

/** True when a quantized type is in effect only because of the `auto` default. */
export function kvDefaultsInEffect(input: KvCacheInput): boolean {
  const resolved = resolveKvCacheTypes(input)
  return (
    (isAuto(input.cacheTypeK) && resolved.k !== F16) ||
    (isAuto(input.cacheTypeV) && resolved.v !== F16)
  )
}

const KV_FAILURE_RE =
  /flash[\s_-]?attn|cache quantization|quantized\s+[kv]\s+cache|cache[\s_-]?type|failed to create context/i

/**
 * Whether a failed load should be retried once with f16 KV. The plugin's load
 * error carries the engine's own text when it has any; when the worker only
 * exited (`exit_code=N`, which is what a context-creation failure under a
 * router child reports) there is nothing to match, and the defaults are the
 * only suspect. Classified causes (out of memory, missing libraries, ...)
 * carry other codes and are never retried here.
 */
export function shouldRetryLoadWithF16Kv(args: {
  error: unknown
  defaultsInEffect: boolean
  alreadyRetried: boolean
}): boolean {
  if (!args.defaultsInEffect || args.alreadyRetried) return false
  const e = args.error as
    | { code?: unknown; message?: unknown; details?: unknown }
    | null
    | undefined
  if (!e || typeof e !== 'object' || e.code !== 'MODEL_LOAD_FAILED') return false
  const details = typeof e.details === 'string' ? e.details : ''
  const text = `${typeof e.message === 'string' ? e.message : ''}\n${details}`
  if (KV_FAILURE_RE.test(text)) return true
  return /^\s*exit_code=/.test(details)
}
