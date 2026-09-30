/** A transcript header a model copied from the history: `[Mara (Plan) to room]:`. */
const HEADER = /^[ \t]*\[[^\]\n]{1,80} to [^\]\n]{1,60}\]:[ \t]*/

/**
 * Tidy a reply before it is stored: drop transcript headers the model copied
 * from the history, and collapse a paragraph repeated back to back.
 *
 * The history shows every other speaker as `[Name (role) to address]: text`, and
 * a model writing in that room starts its own reply the same way. Left in, the
 * header hides the `@Name` that follows it from addressing, and because a
 * participant's own earlier replies are sent back to it, the habit feeds itself
 * until a near-greedy model loops on one sentence.
 */
export function cleanReply(raw: string): string {
  const stripped = raw
    .split('\n')
    .map((line) => line.replace(HEADER, ''))
    .join('\n')
  const out: string[] = []
  let last = ''
  for (const paragraph of stripped.split(/\n{2,}/)) {
    const key = paragraph.trim()
    if (!key) continue
    if (key === last) continue
    last = key
    out.push(paragraph.trim())
  }
  return out.length ? out.join('\n\n') : stripped.trim()
}
