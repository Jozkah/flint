/** Below this many output tokens a tokens/sec figure is noise. */
export const MIN_SPEED_TOKENS = 20
/** Below this duration a tokens/sec figure is noise too. */
export const MIN_SPEED_DURATION_MS = 500

/**
 * Whether a generation speed is worth showing. A 7-token reply timed over a
 * few milliseconds reads as "1167 tokens/sec", which says nothing about the
 * model, so short replies and short durations hide the figure.
 */
export function isMeaningfulSpeed(
  tokenCount: number,
  durationMs: number | undefined
): boolean {
  if (tokenCount < MIN_SPEED_TOKENS) return false
  if (durationMs !== undefined && durationMs < MIN_SPEED_DURATION_MS)
    return false
  return true
}
