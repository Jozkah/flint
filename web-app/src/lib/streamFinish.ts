/**
 * Whether a stream's `finish` part describes a reply the provider never
 * finished.
 *
 * An OpenAI-compatible stream that is cut off -- the connection drops before a
 * `finish_reason` arrives -- still ends in a `finish` part, with
 * `finishReason: 'other'` and no `rawFinishReason`, because none was ever sent.
 * A reply that did finish carries the provider's own reason. Measured against
 * the smoke fixture's `fail` script (cut off) and its `plain` one (finished).
 *
 * Whoever converts a model stream into UI chunks puts this on the finish
 * message's metadata as `streamCutOff`; `consumeStep` reads it back and turns
 * the step into an error, so a truncated reply is never read as an answer.
 */
export function streamCutOff(part: unknown): boolean {
  const p = part as { finishReason?: unknown; rawFinishReason?: unknown }
  return p.finishReason === 'other' && p.rawFinishReason === undefined
}
