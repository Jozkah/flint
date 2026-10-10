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
  const fallback = opts.fallback === true
  const k =
    explicitType(input.cacheTypeK) ??
    (isAuto(input.cacheTypeK) && !fallback ? KV_CACHE_DEFAULT_QUANT : F16)

  let v =
    explicitType(input.cacheTypeV) ??
    (isAuto(input.cacheTypeV) && !fallback && input.flashAttn === 'on'
      ? KV_CACHE_DEFAULT_QUANT
      : F16)
  if (input.flashAttn === 'off' && isQuantized(v)) v = F16
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
