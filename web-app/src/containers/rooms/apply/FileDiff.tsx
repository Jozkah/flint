import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  capRows,
  diffRows,
  gutterNumber,
  ROWS_PAGE,
  type PatchFile,
} from '@/lib/rooms/applyReview'

type T = (key: string, options?: Record<string, unknown>) => string

/**
 * One file of a patch as a gutter diff: one line-number column, +/− marks,
 * long lines wrapped so the dialog never scrolls sideways.
 */
export function FileDiff({ file, t }: { file: PatchFile; t: T }) {
  const rows = useMemo(() => diffRows(file.diff), [file])
  const [limit, setLimit] = useState(ROWS_PAGE)
  if (file.binary) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">{t('rooms:apply.binary')}</p>
  }
  if (rows.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">{t('rooms:apply.noLines')}</p>
  }
  const { shown, hidden } = capRows(rows, limit)
  const width = String(rows.reduce((m, r) => Math.max(m, gutterNumber(r) ?? 0), 0)).length
  const num = { width: `${width + 2}ch` }
  return (
    <div>
      <div className="bg-code-bg font-mono text-xs leading-[1.6]" data-testid="apply-file-diff">
        {shown.map((r, i) =>
          r.kind === 'hunk' ? (
            <div key={i} className="truncate bg-muted/50 px-4 py-1 text-subtle-foreground">
              {r.text}
            </div>
          ) : (
            <div
              key={i}
              data-kind={r.kind}
              className={cn(
                'flex min-w-0',
                r.kind === 'add' && 'bg-diff-add-bg',
                r.kind === 'remove' && 'bg-diff-del-bg',
                r.kind === 'context' && 'text-fg-2',
                r.kind === 'meta' && 'text-muted-foreground italic'
              )}
            >
              <span
                aria-hidden
                style={num}
                className={cn(
                  'shrink-0 select-none py-px pr-2 pl-2 text-right tabular-nums',
                  r.kind === 'add'
                    ? 'bg-diff-add-ln text-diff-add'
                    : r.kind === 'remove'
                      ? 'bg-diff-del-ln text-diff-del'
                      : 'text-subtle-foreground'
                )}
              >
                {gutterNumber(r) ?? ''}
              </span>
              <span
                aria-hidden
                className={cn(
                  'w-5 shrink-0 select-none py-px text-center',
                  r.kind === 'add' && 'text-diff-add',
                  r.kind === 'remove' && 'text-diff-del'
                )}
              >
                {r.kind === 'add' ? '+' : r.kind === 'remove' ? '−' : ''}
              </span>
              <span className="min-w-0 flex-1 py-px pr-4 break-words whitespace-pre-wrap">{r.text || ' '}</span>
            </div>
          )
        )}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + ROWS_PAGE)}
          className="w-full border-t border-border px-4 py-2 text-left text-xs text-muted-foreground hover:bg-hover-row hover:text-foreground"
        >
          {t('rooms:apply.showMore', { count: Math.min(hidden, ROWS_PAGE) })}{' '}
          <span className="opacity-70">{t('rooms:apply.hiddenLines', { count: hidden })}</span>
        </button>
      )}
    </div>
  )
}
