import type { UIMessage } from '@ai-sdk/react'

/** The part of a speed block that adds up across the requests of one reply. */
export type ReplySpeed = {
  tokenSpeed: number
  tokenCount: number
  durationMs: number
}

/**
 * The speed block of the reply a request continues, if it continues one: a
 * request that ends on an assistant message (sent after a tool ran) adds to
 * that reply; one that ends on a user message starts a new reply.
 */
export function earlierTokenSpeed(
  messages: readonly UIMessage[]
): ReplySpeed | undefined {
  const last = messages[messages.length - 1]
  if (last?.role !== 'assistant') return undefined
  const speed = (
    last.metadata as { tokenSpeed?: Partial<ReplySpeed> } | undefined
  )?.tokenSpeed
  if (typeof speed?.tokenCount !== 'number') return undefined
  return {
    tokenSpeed: typeof speed.tokenSpeed === 'number' ? speed.tokenSpeed : 0,
    tokenCount: speed.tokenCount,
    durationMs: typeof speed.durationMs === 'number' ? speed.durationMs : 0,
  }
}

/** Time spent generating `tokens` at `speed` tokens/s; 0 when not measured. */
const generationMs = (tokens: number, speed: number) =>
  speed > 0 ? (tokens / speed) * 1000 : 0

/**
 * Adds one request to the reply so far: the token count is the reply's total
 * and the speed its total output over its total generation time. Earlier
 * tokens whose speed was never measured are counted, but their time is not
 * guessed.
 */
export function addToReplySpeed(
  earlier: ReplySpeed | undefined,
  call: ReplySpeed
): ReplySpeed {
  if (!earlier) return call
  const timedTokens =
    (earlier.tokenSpeed > 0 ? earlier.tokenCount : 0) +
    (call.tokenSpeed > 0 ? call.tokenCount : 0)
  const timedMs =
    generationMs(earlier.tokenCount, earlier.tokenSpeed) +
    generationMs(call.tokenCount, call.tokenSpeed)
  return {
    tokenSpeed: timedMs > 0 ? timedTokens / (timedMs / 1000) : 0,
    tokenCount: earlier.tokenCount + call.tokenCount,
    durationMs: earlier.durationMs + call.durationMs,
  }
}
