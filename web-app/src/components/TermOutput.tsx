import { memo, useMemo, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Terminal text in the terminal palette (styles/chat.css `.term-*`).
 *
 * Real ANSI colour codes are honoured when a command emits them. Most tools
 * print plain text once they see they are not attached to a TTY, so plain
 * output gets a light, line-based reading instead: failures red, passes and
 * progress verbs green, warnings yellow. It only ever colours; it never hides
 * or reorders a character, so the text stays exactly what the command printed.
 */

type Span = { text: string; cls?: string }

const SGR_COLOURS: Record<number, string> = {
  30: 'term-d',
  31: 'term-r',
  32: 'term-g',
  33: 'term-y',
  34: 'term-b',
  35: 'term-m',
  36: 'term-c',
  37: 'term-w',
  90: 'term-d',
  91: 'term-r',
  92: 'term-g',
  93: 'term-y',
  94: 'term-b',
  95: 'term-m',
  96: 'term-c',
  97: 'term-w',
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[([0-9;]*)m/g
// eslint-disable-next-line no-control-regex
const HAS_ANSI = /\x1b\[[0-9;]*m/

/** Split text on SGR escapes, carrying colour and bold across them. */
function parseAnsi(text: string): Span[] {
  const spans: Span[] = []
  let colour: string | undefined
  let bold = false
  let last = 0
  const push = (chunk: string) => {
    if (!chunk) return
    spans.push({ text: chunk, cls: cn(colour, bold && 'font-semibold') || undefined })
  }
  for (const m of text.matchAll(ANSI)) {
    push(text.slice(last, m.index))
    last = (m.index ?? 0) + m[0].length
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number)
    for (const code of codes) {
      if (code === 0) {
        colour = undefined
        bold = false
      } else if (code === 1) bold = true
      else if (code === 22) bold = false
      else if (code === 39) colour = undefined
      else if (SGR_COLOURS[code]) colour = SGR_COLOURS[code]
    }
  }
  push(text.slice(last))
  return spans
}

const FAIL = /\b(error|errors|failed|failure|fatal|panicked|FAILED|FAIL)\b/
const WARN = /\b(warning|warn|deprecated)\b/i
const PASS =
  /^\s*(Compiling|Finished|Running|Checking|Downloaded|Updating|Installing|Built|Done)\b|\b(ok|passed|PASS|success|succeeded)\b/

/** One plain line's colour, from what it says. */
function lineClass(line: string): string | undefined {
  if (FAIL.test(line)) return 'term-r'
  if (WARN.test(line)) return 'term-y'
  if (PASS.test(line)) return 'term-g'
  return undefined
}

export const TermOutput = memo(
  ({ text, className }: { text: string; className?: string }) => {
    const content = useMemo<ReactNode>(() => {
      if (HAS_ANSI.test(text)) {
        return parseAnsi(text).map((s, i) =>
          s.cls ? (
            <span key={i} className={s.cls}>
              {s.text}
            </span>
          ) : (
            s.text
          )
        )
      }
      const lines = text.split('\n')
      return lines.map((line, i) => {
        const cls = lineClass(line)
        const nl = i < lines.length - 1 ? '\n' : ''
        return cls ? (
          <span key={i} className={cls}>
            {line}
            {nl}
          </span>
        ) : (
          line + nl
        )
      })
    }, [text])
    return <span className={className}>{content}</span>
  }
)

TermOutput.displayName = 'TermOutput'
