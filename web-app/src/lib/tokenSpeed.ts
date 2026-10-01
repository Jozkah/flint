/** Below this many output tokens a tokens/sec figure is noise. */
export const MIN_SPEED_TOKENS = 8
/**
 * Below this duration a tokens/sec figure is noise too. The clock starts at
 * the first output, so a short reply on a fast model really does finish in
 * well under a quarter of a second; a higher floor hid those replies' speed.
 */
export const MIN_SPEED_DURATION_MS = 50

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

/** What a reply's speed is measured from; the shape both surfaces store. */
export type SpeedSample = {
  tokenSpeed?: number
  tokenCount?: number
  durationMs?: number
}

/**
 * The speed of the latest measurable reply, and the average over all of them
 * weighted by tokens (so a long reply counts for more than a one-liner).
 * Replies too short or too quick to time are left out, as they are beside the
 * message itself. Both are absent when nothing could be measured.
 */
export function speedStats(samples: readonly (SpeedSample | undefined | null)[]): {
  last?: number
  average?: number
} {
  let last: number | undefined
  let weighted = 0
  let weight = 0
  for (const s of samples) {
    const speed = s?.tokenSpeed
    if (!speed || !Number.isFinite(speed) || speed <= 0) continue
    const tokens = s?.tokenCount ?? 0
    if (!isMeaningfulSpeed(tokens, s?.durationMs)) continue
    last = speed
    weighted += speed * tokens
    weight += tokens
  }
  return weight > 0 ? { last, average: weighted / weight } : {}
}

/**
 * How much of a speculative draft the model kept, as a whole percentage, or
 * null when no draft ran. `draftTokens` is how many were proposed.
 */
export function draftAcceptancePercent(sample: {
  draftTokens?: number
  draftAccepted?: number
}): number | null {
  const total = sample.draftTokens
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
    return null
  }
  const accepted = Math.min(Math.max(sample.draftAccepted ?? 0, 0), total)
  return Math.round((accepted / total) * 100)
}
