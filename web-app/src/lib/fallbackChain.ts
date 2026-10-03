import { isContextOverflowMessage } from '@/utils/error'

/** A fallback entry is stored as `provider::modelId`, like the router's cache key. */
const SEP = '::'

export const fallbackRef = (provider: string, modelId: string) =>
  `${provider}${SEP}${modelId}`

export function parseFallbackRef(ref: string) {
  const i = ref.indexOf(SEP)
  if (i <= 0 || i + SEP.length >= ref.length) return null
  return { provider: ref.slice(0, i), modelId: ref.slice(i + SEP.length) }
}

type ProviderLike<M extends { id: string }> = { provider: string; models: M[] }

/**
 * The models to try after `current`, in the configured order. Entries that are
 * the current model, repeated, or no longer installed are skipped, so a stale
 * setting never turns into a request to a model that does not exist.
 */
export function resolveFallbackChain<M extends { id: string }>(
  refs: readonly string[],
  current: { provider: string; modelId: string },
  providers: readonly ProviderLike<M>[]
): { selectedProvider: string; selectedModel: M }[] {
  const seen = new Set([fallbackRef(current.provider, current.modelId)])
  const chain: { selectedProvider: string; selectedModel: M }[] = []
  for (const ref of refs) {
    if (seen.has(ref)) continue
    const parsed = parseFallbackRef(ref)
    if (!parsed) continue
    const model = providers
      .find((p) => p.provider === parsed.provider)
      ?.models.find((m) => m.id === parsed.modelId)
    if (!model) continue
    seen.add(ref)
    chain.push({ selectedProvider: parsed.provider, selectedModel: model })
  }
  return chain
}

const MODEL_UNAVAILABLE =
  /model[^.\n]{0,40}(not (been )?(loaded|found|available|ready)|failed to load|unavailable)|failed to load model|failed to create model|createModelFailed|loading model/i
// A key, login or plan problem: the same request fails the same way on any
// other model of that provider, but another provider has its own credentials.
const CREDENTIALS =
  /api[ _-]?key|unauthori[sz]ed|forbidden|authenticat|invalid (token|credentials)|permission|billing|quota|insufficient|credit/i
const TRANSIENT =
  /overload|unavailable|temporarily|try again|rate.?limit|too many requests|timed? ?out|timeout|ECONN(REFUSED|RESET)|ETIMEDOUT|fetch failed|failed to fetch|network|socket hang up|bad gateway|gateway time-?out|server error|internal server error/i

function statusOf(error: unknown, message: string): number | null {
  const e = error as { statusCode?: unknown; status?: unknown } | null
  for (const v of [e?.statusCode, e?.status]) {
    if (typeof v === 'number' && v >= 100 && v < 600) return v
  }
  const m = message.match(/\b(?:status(?: code)?|http)\D{0,3}([1-5]\d\d)\b/i)
  return m ? Number(m[1]) : null
}

/**
 * Whether a failed request is worth retrying on another model: the model or
 * server is overloaded, unreachable or not loaded. A stop, an oversized
 * prompt, or a 4xx the next model would reject too is not. A credentials
 * failure only moves on to a model of a different provider.
 */
export function shouldFallback(
  error: unknown,
  aborted = false,
  otherProvider = false
): boolean {
  if (aborted) return false
  if (error instanceof Error && error.name === 'AbortError') return false
  const cause = (error as { cause?: unknown } | null)?.cause
  const message = [
    error instanceof Error ? error.message : String(error ?? ''),
    cause instanceof Error ? cause.message : '',
  ].join(' ')
  if (isContextOverflowMessage(message)) return false
  const status = statusOf(error, message)
  if (status === 401 || status === 403 || CREDENTIALS.test(message)) {
    return otherProvider
  }
  if (MODEL_UNAVAILABLE.test(message)) return true
  if (status !== null) return status === 408 || status === 429 || status >= 500
  return TRANSIENT.test(message)
}
