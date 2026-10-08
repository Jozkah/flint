/** A server's capacity may constrain a chosen cap, but cannot enlarge it. */
export function cappedContextWindow(configured?: number | null, discovered?: number | null): number | undefined {
  const valid = (value: number | null | undefined) =>
    value != null && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
  const cap = valid(configured)
  const window = valid(discovered)
  return cap != null && window != null ? Math.min(cap, window) : cap ?? window
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
      'The latest message or fixed prompt is too large to fit after compaction; shorten it or reduce the enabled tools. ' +
      'If the window looks wrong, set Max Context Tokens for this model.')
  }
}

/** Calibrate heuristic prompt counts against this engine's reported usage. */
export class ContextEstimate {
  private ratios = new Map<string, number>()

  ratio(key: string): number {
    return this.ratios.get(key) ?? 1
  }

  observe(key: string, estimated: number, reported: number | undefined): void {
    if (!Number.isFinite(estimated) || estimated <= 0 ||
        reported == null || !Number.isFinite(reported) || reported <= 0) return
    // Never expand the budget on a low estimate. Add slack when the provider
    // counts more densely, and keep the largest discrepancy seen for it.
    if (reported > estimated) {
      this.ratios.set(key, Math.max(this.ratio(key), reported / estimated * 1.1))
    }
  }
}
