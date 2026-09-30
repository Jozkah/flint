/**
 * How much of a long transcript is drawn when a session opens.
 *
 * Every message and tool card was drawn at once, so opening a long agentic
 * session meant rendering hundreds of them before anything showed. Measured on
 * a real session: 30 messages held 227 tool cards and 18,700 DOM nodes, about a
 * second of rendering, because one message can carry dozens of calls. The
 * window is therefore counted in work, not in messages: each message costs one
 * plus one per tool call, and the newest messages are drawn until that budget
 * is spent. Each press of "Show earlier" adds another budget. The session
 * itself keeps everything.
 */
export const TRANSCRIPT_BUDGET = 60

/** The newest messages are always drawn, however heavy. */
const MIN_DRAWN = 2

/** What drawing one message costs: itself, plus each tool call it carries. */
export function messageWeight(parts: readonly { type: string }[] | undefined): number {
  let tools = 0
  for (const p of parts ?? []) if (p.type.startsWith('tool-')) tools++
  return 1 + tools
}

/** Index of the first message to draw, after `pages` presses of "Show earlier". */
export function transcriptWindowStart(weights: readonly number[], pages: number): number {
  const budget = TRANSCRIPT_BUDGET * (Math.max(0, pages) + 1)
  let spent = 0
  let start = weights.length
  while (start > 0) {
    const w = weights[start - 1]
    if (weights.length - start >= MIN_DRAWN && spent + w > budget) break
    spent += w
    start--
  }
  return start
}
