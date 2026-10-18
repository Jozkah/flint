/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { codeToTokens, type BundledLanguage } from 'shiki'
import { cn } from '@/lib/utils'
import { detectLanguage } from '@/lib/coworkCode'
import { tooHeavyToHighlight } from '@/lib/highlightLimits'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useTheme } from '@/hooks/useTheme'

/**
 * A change card's per-file excerpt as a gutter diff: one line-number column,
 * a +/− mark and the text, coloured by the same Shiki themes as the
 * transcript's code blocks and wrapping or scrolling as they do (the
 * "Wrap code lines" setting). Standalone on purpose: the Apply review dialog
 * is being redesigned separately, so nothing here is shared with it.
 *
 * Two excerpt shapes arrive. A git diff for a file (possibly with its
 * `diff --git` / `index` / `---` / `+++` plumbing, which is dropped) and the
 * record of a turn's write/edit calls: bare `+`/`-` lines separated by `@@`
 * on its own line, which carry no line numbers.
 */
export type ExcerptRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'break' }
  | { kind: 'add' | 'remove' | 'context' | 'meta'; text: string; number?: number }

export type ExcerptFileStatus = 'added' | 'deleted' | 'renamed' | 'modified'

const HUNK = /^@@+\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@+(.*)$/
const PLUMBING =
  /^(diff --git |index |--- |\+\+\+ |similarity index |dissimilarity index |rename (from|to) |copy (from|to) |new file mode |deleted file mode |old mode |new mode |Binary files )/

/** What the plumbing says about the file, before it is dropped. */
export function excerptStatus(excerpt: string | undefined): ExcerptFileStatus {
  if (!excerpt) return 'modified'
  for (const line of excerpt.split('\n')) {
    if (line.startsWith('@@')) break
    if (line.startsWith('new file mode')) return 'added'
    if (line.startsWith('deleted file mode')) return 'deleted'
    if (line.startsWith('rename to ')) return 'renamed'
  }
  return 'modified'
}

export function excerptRows(excerpt: string): ExcerptRow[] {
  const rows: ExcerptRow[] = []
  let oldLine = 0
  let newLine = 0
  let numbered = false
  for (const raw of excerpt.replace(/\n$/, '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    const m = HUNK.exec(line)
    if (m) {
      numbered = true
      oldLine = Number(m[1])
      newLine = Number(m[3])
      const heading = m[5]?.trim()
      const header = line.slice(0, line.lastIndexOf('@@') + 2)
      rows.push({ kind: 'hunk', text: heading ? `${header} ${heading}` : header })
      continue
    }
    if (line === '@@') {
      numbered = false
      if (rows.length) rows.push({ kind: 'break' })
      continue
    }
    if (!numbered && PLUMBING.test(line)) continue
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), ...(numbered ? { number: newLine++ } : {}) })
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'remove', text: line.slice(1), ...(numbered ? { number: oldLine++ } : {}) })
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'meta', text: line.slice(1).trim() })
    } else {
      const text = line.startsWith(' ') ? line.slice(1) : line
      if (numbered) {
        rows.push({ kind: 'context', text, number: newLine++ })
        oldLine++
      } else {
        rows.push({ kind: 'context', text })
      }
    }
  }
  return rows
}

/**
 * A path that loses whole segments from its middle, never half a word:
 * `C:\Users\me\…\workspaces\sonnet`. The root segment always stays, then as
 * many trailing segments as fit in `max` characters.
 */
export function shortenPath(path: string, max: number): string {
  if (path.length <= max) return path
  const sep = path.includes('\\') ? '\\' : '/'
  const parts = path.split(sep)
  if (parts.length < 3) return path
  const head = parts[0] + sep + '…'
  let tail = ''
  for (let i = parts.length - 1; i > 0; i--) {
    const next = sep + parts[i] + tail
    if (head.length + next.length > max && tail) break
    tail = next
  }
  return head + tail
}

const isCode = (r: ExcerptRow): r is Extract<ExcerptRow, { text: string; number?: number }> =>
  r.kind === 'add' || r.kind === 'remove' || r.kind === 'context'

type Tokens = { content: string; color?: string }[][]

/**
 * Shiki tokens for the code rows, one entry per code row, in the active theme.
 * `null` until they arrive, or when the excerpt is too heavy or the grammar
 * fails; the rows then show plain.
 */
function useExcerptTokens(rows: ExcerptRow[], path: string | undefined, isDark: boolean): Tokens | null {
  const code = useMemo(() => rows.filter(isCode).map((r) => r.text).join('\n'), [rows])
  const lang = useMemo(() => (path ? detectLanguage(path).lang : 'text'), [path])
  const [tokens, setTokens] = useState<{ key: string; tokens: Tokens } | null>(null)
  const key = `${lang}:${isDark}:${code}`
  useEffect(() => {
    if (lang === 'text' || !code || tooHeavyToHighlight(code)) return
    let alive = true
    codeToTokens(code, { lang: lang as BundledLanguage, theme: isDark ? 'one-dark-pro' : 'one-light' }).then(
      (r) => {
        if (alive && r?.tokens?.length) setTokens({ key, tokens: r.tokens })
      },
      () => {}
    )
    return () => {
      alive = false
    }
  }, [code, lang, isDark, key])
  return tokens?.key === key ? tokens.tokens : null
}

const ROW_TONE: Record<string, string> = {
  // A light wash of the diff tint over the code background, not a solid block.
  add: 'bg-[color-mix(in_oklab,var(--diff-add-bg)_60%,transparent)]',
  remove: 'bg-[color-mix(in_oklab,var(--diff-del-bg)_60%,transparent)]',
  context: '',
  meta: 'text-muted-foreground italic',
}

const GUTTER_TONE: Record<string, string> = {
  add: 'bg-diff-add-ln text-diff-add',
  remove: 'bg-diff-del-ln text-diff-del',
  context: 'text-subtle-foreground',
  meta: 'text-subtle-foreground',
}

const MARKER: Record<string, string> = { add: '+', remove: '−', context: '', meta: '' }

function Line({ text, tokens }: { text: string; tokens?: Tokens[number] }) {
  if (!tokens) return <>{text || ' '}</>
  const out: ReactNode[] = tokens.map((tok, i) => (
    <span key={i} style={tok.color ? { color: tok.color } : undefined}>
      {tok.content}
    </span>
  ))
  return <>{out.length ? out : ' '}</>
}

export function ChangeExcerptDiff({
  excerpt,
  path,
  className,
}: {
  excerpt: string
  /** The file's path, for the language the lines are coloured as. */
  path?: string
  className?: string
}) {
  const rows = useMemo(() => excerptRows(excerpt), [excerpt])
  const isDark = useTheme((s) => s.isDark)
  const wrap = useInterfaceSettings((s) => s.wrapCodeLines)
  const tokens = useExcerptTokens(rows, path, isDark)
  const width = useMemo(
    () => String(rows.reduce((m, r) => Math.max(m, 'number' in r ? (r.number ?? 0) : 0), 0)).length,
    [rows]
  )
  // The number column: at least three digits wide, so short and long files line up.
  const gutter = { width: `${Math.max(width, 3) + 1.5}ch` }
  let codeIndex = 0
  return (
    <div
      data-testid="change-excerpt"
      data-wrap={wrap ? 'on' : undefined}
      className={cn(
        'max-h-80 overflow-auto bg-code-bg font-mono text-xs leading-[1.6] text-foreground [scrollbar-width:thin]',
        className
      )}
    >
      <div className={cn(!wrap && 'w-max min-w-full')}>
        {rows.map((r, i) => {
          if (r.kind === 'break') {
            return <div key={i} aria-hidden className="my-0.5 border-t border-dashed border-border" />
          }
          if (r.kind === 'hunk') {
            return (
              <div key={i} className="select-none bg-muted/50 px-3 py-0.5 text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground">
                {r.text}
              </div>
            )
          }
          const line = isCode(r) ? tokens?.[codeIndex++] : undefined
          return (
            <div key={i} data-kind={r.kind} className={cn('flex', ROW_TONE[r.kind])}>
              <span
                aria-hidden
                style={gutter}
                className={cn(
                  'shrink-0 select-none self-stretch pr-1.5 text-right text-[length:calc(var(--ui-font-base)*0.6875)] tabular-nums',
                  GUTTER_TONE[r.kind]
                )}
              >
                {r.number ?? ''}
              </span>
              <span
                aria-hidden
                className={cn(
                  'w-5 shrink-0 select-none text-center font-medium',
                  r.kind === 'add' && 'text-diff-add',
                  r.kind === 'remove' && 'text-diff-del'
                )}
              >
                {MARKER[r.kind]}
              </span>
              <span className={cn('min-w-0 pr-3', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
                <Line text={r.text} tokens={line} />
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
