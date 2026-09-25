import { memo, useMemo } from 'react'
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

const LINE = /^([+\- ]) \s*(\d+) \| ?(.*)$/

const parseLine = (line: string): ChangeLine => {
  if (line.startsWith('@@')) return { kind: 'hunk', num: '', text: line }
  const m = LINE.exec(line)
  if (!m) return { kind: 'gap', num: '', text: line.trim() }
  const kind = m[1] === '+' ? 'add' : m[1] === '-' ? 'del' : 'ctx'
  return { kind, num: m[2], text: m[3] }
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

/**
 * A `write`/`edit` diff: the change a call made, or -- in its approval prompt
 * -- the change it would make. One component for both, so what is approved
 * and what is reported afterwards look the same. A line-number gutter, a
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
        diff
          .replace(/\n$/, '')
          .split('\n')
          .map(parseLine),
      [diff]
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
              <div
                key={i}
                className={cn('grid grid-cols-[38px_18px_minmax(0,1fr)] whitespace-pre', ROW[line.kind])}
              >
                <span />
                <span />
                <span>{line.text || ' '}</span>
              </div>
            ) : (
              <div
                key={i}
                className={cn(
                  'grid grid-cols-[38px_18px_minmax(0,1fr)] whitespace-pre text-fg-2',
                  ROW[line.kind]
                )}
              >
                <span
                  className={cn(
                    'select-none pr-2 text-right text-subtle-foreground tabular-nums',
                    GUTTER[line.kind]
                  )}
                >
                  {line.num}
                </span>
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
                <span className="pr-3">{line.text || ' '}</span>
              </div>
            )
          )}
        </div>
      </div>
    )
  }
)

ChangeDiff.displayName = 'ChangeDiff'
