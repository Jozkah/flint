/* eslint-disable react-refresh/only-export-components */
import { memo, useMemo, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * One line of a `write`/`edit` diff. The format comes from
 * `render_edit_diff`/`render_write_diff` in Rust: `@@ ... @@` hunk headers,
 * then lines shaped `S NNNN | text` where S is `+`, `-` or a space, and a
 * bare `...` where unchanged lines were elided.
 */
type ChangeLine = {
  kind: 'hunk' | 'gap' | 'add' | 'del' | 'ctx'
  /** The file line number; empty on hunk headers and gaps. */
  num: string
  text: string
}

/** A line with both sides' numbers, as a unified diff shows them. */
type NumberedLine = ChangeLine & { oldNum: string; newNum: string }

const LINE = /^([+\- ]) \s*(\d+) \| ?(.*)$/

const parseLine = (line: string): ChangeLine => {
  if (line.startsWith('@@')) return { kind: 'hunk', num: '', text: line }
  const m = LINE.exec(line)
  if (!m) return { kind: 'gap', num: '', text: line.trim() }
  const kind = m[1] === '+' ? 'add' : m[1] === '-' ? 'del' : 'ctx'
  return { kind, num: m[2], text: m[3] }
}

/**
 * Rust numbers deletions on the old side and everything else on the new one,
 * and a hunk starts on the same line of both. So the old number of a context
 * line is its new number less the lines added minus removed above it.
 */
const withBothNumbers = (lines: ChangeLine[]): NumberedLine[] => {
  let delta = 0
  return lines.map((line) => {
    if (line.kind === 'hunk') {
      delta = 0
      return { ...line, oldNum: '', newNum: '' }
    }
    if (line.kind === 'add') {
      delta++
      return { ...line, oldNum: '', newNum: line.num }
    }
    if (line.kind === 'del') {
      delta--
      return { ...line, oldNum: line.num, newNum: '' }
    }
    if (line.kind === 'ctx') {
      const n = Number(line.num)
      return { ...line, oldNum: String(n - delta), newNum: line.num }
    }
    return { ...line, oldNum: '', newNum: '' }
  })
}

/** Lines added and removed, for a card's `+6 −1`. */
export const diffStat = (diff: string): { add: number; del: number } => {
  let add = 0
  let del = 0
  for (const raw of diff.split('\n')) {
    const line = parseLine(raw)
    if (line.kind === 'add') add++
    else if (line.kind === 'del') del++
  }
  return { add, del }
}

const KEYWORDS = new Set(
  'as async await break case catch class const continue def default do else enum export extends false fn for from function if impl import in interface let loop match mod mut new null pub return self static struct super switch this throw true try type use var void while yield'.split(
    ' '
  )
)

/**
 * A light, language-agnostic highlight: comments, strings, keywords and the
 * name before a call. Enough for a diff to read like code without shipping a
 * grammar per language into every tool card.
 */
const TOKEN =
  /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|([A-Za-z_][\w]*!?)(?=\s*\()|([A-Za-z_]\w*)/g

const highlight = (text: string): ReactNode[] => {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const [whole, comment, str, call, word] = m
    const cls = comment
      ? 'dl-cm'
      : str
        ? 'dl-str'
        : call
          ? KEYWORDS.has(call)
            ? 'dl-kw'
            : 'dl-fn'
          : word && KEYWORDS.has(word)
            ? 'dl-kw'
            : undefined
    out.push(
      cls ? (
        <span key={at} className={cls}>
          {whole}
        </span>
      ) : (
        whole
      )
    )
    last = at + whole.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const ROW: Record<ChangeLine['kind'], string> = {
  add: 'bg-diff-add-bg',
  del: 'bg-diff-del-bg',
  ctx: '',
  hunk: 'bg-accent text-muted-foreground',
  gap: 'text-subtle-foreground',
}

const GUTTER: Record<ChangeLine['kind'], string> = {
  add: 'bg-diff-add-ln',
  del: 'bg-diff-del-ln',
  ctx: '',
  hunk: '',
  gap: '',
}

const GRID = 'grid grid-cols-[38px_38px_18px_minmax(0,1fr)] whitespace-pre'

/**
 * A `write`/`edit` diff: the change a call made, or -- in its approval prompt
 * -- the change it would make. One component for both, so what is approved
 * and what is reported afterwards look the same. Old and new line numbers, a
 * `+`/`-` column (so the change still reads without colour) and the text.
 */
export const ChangeDiff = memo(
  ({
    diff,
    className,
    label,
    testId,
    bleed = false,
  }: {
    diff: string
    /** Edge to edge inside a tool card, under a dashed rule, not boxed. */
    bleed?: boolean
    className?: string
    /** Names the region for assistive technology. */
    label?: string
    testId?: string
  }) => {
    const lines = useMemo(
      () =>
        withBothNumbers(
          diff
            .replace(/\n$/, '')
            .split('\n')
            .map(parseLine)
        ),
      [diff]
    )
    const gutter = (line: NumberedLine, num: string) => (
      <span
        className={cn(
          'select-none pr-2 text-right text-subtle-foreground tabular-nums',
          GUTTER[line.kind]
        )}
      >
        {num}
      </span>
    )
    return (
      <div
        role={label ? 'region' : undefined}
        aria-label={label}
        data-testid={testId}
        data-slot="change-diff"
        className={cn(
          'max-h-64 overflow-auto bg-card font-mono text-xs leading-[1.65]',
          bleed
            ? 'border-t border-dashed border-border'
            : 'rounded-lg border-[0.8px] border-border',
          className
        )}
      >
        {/* Lines keep their shape and scroll sideways inside this box. */}
        <div className="w-max min-w-full">
          {lines.map((line, i) =>
            line.kind === 'hunk' || line.kind === 'gap' ? (
              <div key={i} className={cn(GRID, ROW[line.kind])}>
                <span />
                <span />
                <span />
                <span>{line.text || ' '}</span>
              </div>
            ) : (
              <div key={i} className={cn(GRID, 'text-fg-2', ROW[line.kind])}>
                {gutter(line, line.oldNum)}
                {gutter(line, line.newNum)}
                <span
                  aria-hidden={line.kind === 'ctx'}
                  className={cn(
                    'select-none text-center text-subtle-foreground',
                    line.kind === 'add' && 'text-diff-add',
                    line.kind === 'del' && 'text-diff-del'
                  )}
                >
                  {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}
                </span>
                <span className="pr-3">
                  {line.text ? highlight(line.text) : ' '}
                </span>
              </div>
            )
          )}
        </div>
      </div>
    )
  }
)

ChangeDiff.displayName = 'ChangeDiff'
