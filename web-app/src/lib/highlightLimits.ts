const HIGHLIGHT_MAX_CHARS = 250_000
const HIGHLIGHT_MAX_LINES = 6_000
const HIGHLIGHT_MAX_LINE_LENGTH = 3_000

/** Whether content is too big, too long-lined or too many lines to colour. */
export function tooHeavyToHighlight(content: string): boolean {
  if (content.length > HIGHLIGHT_MAX_CHARS) return true
  let lines = 1
  let run = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      lines++
      run = 0
    } else if (++run > HIGHLIGHT_MAX_LINE_LENGTH) return true
  }
  return lines > HIGHLIGHT_MAX_LINES
}
