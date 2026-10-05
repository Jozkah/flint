/** A server's capacity may constrain a chosen cap, but cannot enlarge it. */
export function cappedContextWindow(configured?: number | null, discovered?: number | null): number | undefined {
  const valid = (value: number | null | undefined) =>
    value != null && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
  const cap = valid(configured)
  const window = valid(discovered)
  return cap != null && window != null ? Math.min(cap, window) : cap ?? window
}

/** Last-message preservation must not bypass the context budget. */
export function assertEstimatedContextFits(estimated: number, ratio: number, window: number, reserve: number): void {
  if (window <= 0) return
  if (Math.ceil(estimated * ratio) + reserve > window) {
    throw new Error('The estimated request exceeds the available context size. ' +
      'The latest message or fixed prompt is too large to fit after compaction; shorten it or reduce the enabled tools.')
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
