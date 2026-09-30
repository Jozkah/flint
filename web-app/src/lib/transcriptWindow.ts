/**
 * How much of a long transcript is drawn when a session opens.
 *
 * Every message and tool card was drawn at once, so opening a long agentic
 * session meant rendering hundreds of them before anything showed. The newest
 * `TRANSCRIPT_WINDOW` are drawn, and each press of "Show earlier" adds that many
 * more. The session itself keeps everything.
 */
export const TRANSCRIPT_WINDOW = 30

/** Index of the first message to draw, given how many earlier blocks were asked for. */
export function transcriptWindowStart(total: number, extra: number): number {
  return Math.max(0, total - TRANSCRIPT_WINDOW - Math.max(0, extra))
}
