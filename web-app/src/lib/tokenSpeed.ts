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

/**
 * Where a speed came from: the server's own timings (llama.cpp), the tokens
 * the provider counted over the time output was arriving, or a token count
 * estimated from the text because the provider reported none.
 */
export type SpeedSource = 'server' | 'measured' | 'estimated'

/** What a reply's speed is measured from; the shape both surfaces store. */
export type SpeedSample = {
  tokenSpeed?: number
  tokenCount?: number
  durationMs?: number
  source?: SpeedSource
}

/**
 * Times the stretch a reply was being generated: any output at all (text,
 * reasoning, tool-call arguments), from the first piece to the last, per
 * step. Waiting for the first token (queue and prompt processing) and running
 * tools between steps are outside it, which is what a generation speed
 * should leave out.
 */
export function createDecodeClock() {
  let first = 0
  let last = 0
  let chars = 0
  let decodeMs = 0
  let steps = 0
  return {
    tick(pieceChars = 0, at = Date.now()) {
      if (first === 0) first = at
      last = at
      chars += pieceChars
    },
    /** Close the current step; a step that arrived in one piece adds no span. */
    endStep() {
      if (last > first) {
        decodeMs += last - first
        steps += 1
      }
      first = 0
      last = 0
    },
    result: () => ({ decodeMs, steps, chars }),
    reset() {
      first = last = chars = decodeMs = steps = 0
    },
  }
}

export type GenerationSpeed = {
  tokenSpeed: number
  tokenCount: number
  durationMs: number
  source: SpeedSource
}

/**
 * A reply's generation speed, from the best figure there is.
 *
 * 1. The server's own (`timings.predicted_per_second`), when it sent one.
 * 2. The provider's output tokens over the decode time. The first piece of
 *    each step arrives with its tokens already generated, so it is not counted
 *    against a span that starts when it lands: tokens minus one per step.
 * 3. With no count from the provider, characters / 4 over the same time,
 *    marked as an estimate.
 * Null when there is nothing to divide by.
 */
export function generationSpeed(input: {
  serverTokensPerSecond?: number | null
  outputTokens?: number | null
  decodeMs: number
  steps?: number
  chars?: number
}): GenerationSpeed | null {
  const reported = input.outputTokens && input.outputTokens > 0 ? input.outputTokens : 0
  const tokens = reported || Math.round((input.chars ?? 0) / 4)
  if (tokens <= 0) return null
  const server = input.serverTokensPerSecond
  if (server && Number.isFinite(server) && server > 0) {
    return {
      tokenSpeed: server,
      tokenCount: tokens,
      durationMs: Math.round((tokens / server) * 1000),
      source: 'server',
    }
  }
  const steps = Math.max(1, input.steps ?? 1)
  if (input.decodeMs <= 0 || tokens <= steps) return null
  return {
    tokenSpeed: (tokens - steps) / (input.decodeMs / 1000),
    tokenCount: tokens,
    durationMs: Math.round(input.decodeMs),
    source: reported ? 'measured' : 'estimated',
  }
}

/**
 * The speed of the latest measurable reply, and the average over all of them:
 * every token over every second spent generating them, so a long reply counts
 * for more than a one-liner and the figure is what the model actually did, not
 * a mean of means. Replies too short or too quick to time are left out, as
 * they are beside the message itself. Both are absent when nothing could be
 * measured; `source` is where the latest figure came from.
 */
export function speedStats(samples: readonly (SpeedSample | undefined | null)[]): {
  last?: number
  average?: number
  source?: SpeedSource
  /** How many replies the average is over. */
  samples?: number
} {
  let last: number | undefined
  let source: SpeedSource | undefined
  let tokensTotal = 0
  let secondsTotal = 0
  let counted = 0
  for (const s of samples) {
    const speed = s?.tokenSpeed
    if (!speed || !Number.isFinite(speed) || speed <= 0) continue
    const tokens = s?.tokenCount ?? 0
    if (!Number.isFinite(tokens) || !isMeaningfulSpeed(tokens, s?.durationMs)) continue
    last = speed
    source = s?.source
    // A figure saved before the origin was recorded came from the old clock
    // (reasoning and tool-argument tokens divided by the visible text's span,
    // or a span that included tool runs). It can be several times too high
    // and cannot be told from a good one, so it is not averaged in.
    if (!s?.source) continue
    tokensTotal += tokens
    secondsTotal += tokens / speed
    counted += 1
  }
  if (last === undefined) return {}
  return {
    last,
    ...(tokensTotal > 0 && secondsTotal > 0
      ? { average: tokensTotal / secondsTotal, samples: counted }
      : {}),
    ...(source ? { source } : {}),
  }
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
