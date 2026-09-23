/**
 * A small ANSI SGR parser for command output. Turns text with colour escape
 * codes into styled segments, and strips every other escape sequence (cursor
 * movement, OSC titles and links, charset switches) so none of it leaks into
 * the rendered text.
 *
 * The 16 standard colours map to `--ansi-*` CSS variables defined per theme,
 * so output stays readable in both light and dark mode. 256-colour and
 * truecolour codes are rendered as literal colours.
 */

export type AnsiStyle = {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

export type AnsiSegment = { text: string; style: AnsiStyle }

const NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
] as const

/** CSS colour for one of the 16 standard palette entries. */
export const paletteColor = (index: number): string =>
  index < 8
    ? `var(--ansi-${NAMES[index]})`
    : `var(--ansi-bright-${NAMES[index - 8]})`

/** CSS colour for an xterm 256-colour index. */
const color256 = (n: number): string | undefined => {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined
  if (n < 16) return paletteColor(n)
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v}, ${v}, ${v})`
  }
  const i = n - 16
  const level = (c: number) => (c === 0 ? 0 : 55 + c * 40)
  return `rgb(${level(Math.floor(i / 36))}, ${level(Math.floor(i / 6) % 6)}, ${level(i % 6)})`
}

// CSI (ESC [ or C1 0x9b) with its parameters and final byte; OSC up to BEL or
// ST; charset designations; any other two-character escape.
const ESCAPE =
  // eslint-disable-next-line no-control-regex
  /(?:\x1b\[|\x9b)([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()*+].|\x1b[^[\]]/g

/** `text` with every ANSI escape sequence removed. */
export function stripAnsi(text: string): string {
  return text.replace(ESCAPE, '')
}

/** Whether `text` contains any escape sequence at all. */
export function hasAnsi(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x1b\x9b]/.test(text)
}

function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes =
    params === ''
      ? [0]
      : params.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)))
  let next: AnsiStyle = { ...style }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) next = {}
    else if (c === 1) next.bold = true
    else if (c === 2) next.dim = true
    else if (c === 3) next.italic = true
    else if (c === 4) next.underline = true
    else if (c === 7) next.inverse = true
    else if (c === 22) {
      next.bold = false
      next.dim = false
    } else if (c === 23) next.italic = false
    else if (c === 24) next.underline = false
    else if (c === 27) next.inverse = false
    else if (c >= 30 && c <= 37) next.fg = paletteColor(c - 30)
    else if (c >= 90 && c <= 97) next.fg = paletteColor(c - 90 + 8)
    else if (c >= 40 && c <= 47) next.bg = paletteColor(c - 40)
    else if (c >= 100 && c <= 107) next.bg = paletteColor(c - 100 + 8)
    else if (c === 39) next.fg = undefined
    else if (c === 49) next.bg = undefined
    else if (c === 38 || c === 48) {
      let color: string | undefined
      if (codes[i + 1] === 5) {
        color = color256(codes[i + 2])
        i += 2
      } else if (codes[i + 1] === 2) {
        const [r, g, b] = codes.slice(i + 2, i + 5)
        if ([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
          color = `rgb(${r}, ${g}, ${b})`
        }
        i += 4
      }
      if (color) {
        if (c === 38) next.fg = color
        else next.bg = color
      }
    }
  }
  return next
}

/** Split `text` into styled segments, dropping non-colour escapes. */
export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  let style: AnsiStyle = {}
  let last = 0
  const push = (chunk: string) => {
    if (!chunk) return
    const prev = segments[segments.length - 1]
    if (prev && prev.style === style) prev.text += chunk
    else segments.push({ text: chunk, style })
  }
  for (const m of text.matchAll(ESCAPE)) {
    push(text.slice(last, m.index))
    last = (m.index ?? 0) + m[0].length
    // Only SGR (`m`) changes style; every other escape is dropped.
    if (m[2] === 'm') style = applySgr(style, m[1] ?? '')
  }
  push(text.slice(last))
  return segments
}
