/** A server's capacity may constrain a chosen cap, but cannot enlarge it. */
export function cappedContextWindow(configured?: number | null, discovered?: number | null): number | undefined {
  const valid = (value: number | null | undefined) =>
    value != null && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
  const cap = valid(configured)
  const window = valid(discovered)
  return cap != null && window != null ? Math.min(cap, window) : cap ?? window
}

/** 32768 -> "32K", 262144 -> "262K"; small numbers stay exact. */
function windowLabel(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1024)}K` : String(tokens)
}

/** Last-message preservation must not bypass the context budget. */
/** Start of the message `assertEstimatedContextFits` throws; the chat banner keys on it. */
export const PREFLIGHT_CONTEXT_ERROR_PREFIX = 'The estimated request exceeds the available context size.'

export function assertEstimatedContextFits(
  estimated: number,
  ratio: number,
  window: number,
  reserve: number,
  source?: string
): void {
  if (window <= 0) return
  const need = Math.ceil(estimated * ratio)
  if (need + reserve > window) {
    throw new Error(`${PREFLIGHT_CONTEXT_ERROR_PREFIX} ` +
      `Flint estimated ${need} prompt tokens plus ${reserve} reserved for the reply, ` +
      `against a window of ${window}${source ? ` (from ${source})` : ''}. ` +
      `This model's window is ${windowLabel(window)}; Flint needs about ${windowLabel(need + reserve)}. ` +
      'Pick a larger-context model or raise Max Context Tokens in Assistant settings. ' +
      'The latest message or fixed prompt is too large to fit after compaction; shorten it or reduce the enabled tools.')
  }
}

/** Bounds of the calibration ratio: the heuristic is never trusted to over-count, nor a tokenizer to count 1.6x denser. */
export const MIN_ESTIMATE_RATIO = 1
export const MAX_ESTIMATE_RATIO = 1.6
/** Observations the median is taken over: old ones fall out. */
const RECENT_SAMPLES = 5
/** Slack over the median, so a typical request still has some margin. */
const RATIO_SLACK = 1.1

/**
 * Calibrate heuristic prompt counts against this engine's reported usage.
 *
 * The median of the last few reported/estimated ratios, with slack, bounded to
 * [1, 1.6]. It used to keep the all-time maximum, so one odd request (a
 * tokenizer-dense paste, a miscounted image) shrank every later budget for
 * good.
 */
export class ContextEstimate {
  private samples = new Map<string, number[]>()

  ratio(key: string): number {
    const recent = this.samples.get(key)
    if (!recent?.length) return 1
    const sorted = [...recent].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    const r = median > 1 ? median * RATIO_SLACK : median
    return Math.min(MAX_ESTIMATE_RATIO, Math.max(MIN_ESTIMATE_RATIO, r))
  }

  observe(key: string, estimated: number, reported: number | undefined): void {
    if (!Number.isFinite(estimated) || estimated <= 0 ||
        reported == null || !Number.isFinite(reported) || reported <= 0) return
    const recent = [...(this.samples.get(key) ?? []), reported / estimated]
    this.samples.set(key, recent.slice(-RECENT_SAMPLES))
  }
}
