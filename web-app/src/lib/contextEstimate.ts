/** A server's capacity may constrain a chosen cap, but cannot enlarge it. */
export function cappedContextWindow(configured?: number | null, discovered?: number | null): number | undefined {
  const valid = (value: number | null | undefined) =>
    value != null && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
  const cap = valid(configured)
  const window = valid(discovered)
  return cap != null && window != null ? Math.min(cap, window) : cap ?? window
}

/**
 * A token count as the message prints it: exact, with thousands separators.
 * It used to print a "K" label divided by 1024 next to the exact number, so a
 * configured 200000 window read as "195K" and looked like a second, different
 * window.
 */
function tokens(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** What the estimate of one request is made of, in heuristic (unscaled) tokens. */
export type EstimateBreakdown = {
  systemPrompt: number
  tools: number
  toolCount: number
  /** Every message before the newest one. */
  history: number
  /** The newest message (the user's, or the tool results being answered). */
  latest: number
}

export type EstimateCheck = {
  /** Where the window came from ("configured", "the last refusal", ...). */
  source?: string
  breakdown?: EstimateBreakdown
  /**
   * Stop on the calibrated estimate. Off, a request whose calibrated count is
   * over but whose plain heuristic count fits is sent: the provider's own
   * count decides, and a length refusal goes through overflow recovery. On
   * for the resend after such a refusal, which must not be sent blind again.
   */
  strict?: boolean
}

/** Last-message preservation must not bypass the context budget. */
/** Start of the message `assertEstimatedContextFits` throws; the chat banner keys on it. */
export const PREFLIGHT_CONTEXT_ERROR_PREFIX = 'The estimated request exceeds the available context size.'

/**
 * Refuse a request that cannot fit the window.
 *
 * `ratio` is the calibration learned from this model's reported usage (see
 * `ContextEstimate`); it carries up to 1.6x of uncertainty. Unless `strict`,
 * the request is refused only when the plain heuristic count (ratio 1) plus
 * the reply reserve is already over the window: a request over only by the
 * calibration margin is sent and the provider decides.
 */
export function assertEstimatedContextFits(
  estimated: number,
  ratio: number,
  window: number,
  reserve: number,
  check: string | EstimateCheck = {}
): void {
  if (window <= 0) return
  const { source, breakdown, strict = true } =
    typeof check === 'string' ? { source: check } : check
  const plain = Math.ceil(estimated)
  const need = Math.ceil(estimated * ratio)
  const over = strict ? need + reserve > window : plain + reserve > window
  if (!over) return
  const scale = (n: number) => tokens(n * ratio)
  const parts = breakdown
    ? [
        ['system prompt', breakdown.systemPrompt],
        [`tool definitions (${breakdown.toolCount} tools)`, breakdown.tools],
        ['earlier conversation', breakdown.history],
        ['latest message', breakdown.latest],
      ] as const
    : []
  const largest = [...parts].sort((a, b) => b[1] - a[1])[0]
  const action = !largest
    ? undefined
    : largest[0].startsWith('tool definitions')
      ? 'turn off MCP servers or tools this conversation does not need'
      : largest[0] === 'system prompt'
        ? 'shorten the assistant instructions, project instructions or remembered facts'
        : largest[0] === 'latest message'
          ? 'shorten it or attach less'
          : 'compact it or start a new one'
  // The largest part comes first: a Cowork run card shows only the first 300
  // characters of a run's error.
  const lead = largest
    ? `Most of it is the ${largest[0]}: ${scale(largest[1])} of ${tokens(need)} prompt tokens; ${action}. `
    : 'Shorten the latest message or reduce the enabled tools. '
  throw new Error(`${PREFLIGHT_CONTEXT_ERROR_PREFIX} ${lead}` +
    `Flint estimated ${tokens(need)} prompt tokens plus ${tokens(reserve)} reserved for the reply, ` +
    `against a window of ${tokens(window)}${source ? ` (from ${source})` : ''}.` +
    (parts.length
      ? ' Estimate by part: ' + parts.map(([label, n]) => `${label} ${scale(n)}`).join(', ') + '.'
      : '') +
    (ratio > 1
      ? ` This includes a x${ratio.toFixed(2)} correction learned from this model's reported usage ` +
        `(${tokens(plain)} before it).`
      : '') +
    ' Or pick a larger-context model or raise Max Context Tokens in Assistant settings.')
}

/**
 * Whether the heuristic estimate of a request covers everything the provider
 * will count. An attached file (image, PDF, audio) and a screenshot sent beside
 * the transcript are not in it, so such a request must not calibrate the ratio:
 * its reported/estimated ratio measures the attachment, not tokenizer density.
 */
export function estimateCountsEveryPart(
  messages: ReadonlyArray<{ parts: ReadonlyArray<{ type: string }> }>,
  screenshots: number
): boolean {
  return screenshots === 0 && !messages.some((m) => m.parts.some((p) => p.type === 'file'))
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
