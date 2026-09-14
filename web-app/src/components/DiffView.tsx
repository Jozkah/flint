import { Fragment, useMemo } from 'react'
import { cn } from '@/lib/utils'
import {
  gutterWidth,
  parseUnifiedDiff,
  truncateDiff,
  type DiffLine,
} from '@/lib/unifiedDiff'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * A unified diff, read-only, in the GitHub shape.
 *
 * Both line-number columns are shown, because "which line is this in the file
 * I have open" is the question a diff exists to answer, and a single column
 * cannot answer it for a hunk that adds and removes.
 *
 * Restrained on purpose: a tinted row and a coloured marker, not a saturated
 * block. And the marker column is the reason the colours are not the only
 * signal — a `+` and a `-` survive a greyscale screen.
 *
 * This surface reviews changes that have already been made. It has no staging,
 * committing or reverting, and nothing it renders goes back to a model.
 */
export function DiffView({
  diff,
  className,
}: {
  diff: string
  className?: string
}) {
  const { t } = useTranslation()
  const { parsed, omitted, width } = useMemo(() => {
    const full = parseUnifiedDiff(diff)
    const { parsed, omitted } = truncateDiff(full)
    return { parsed, omitted, width: gutterWidth(parsed) }
  }, [diff])

  if (parsed.hunks.length === 0) return null

  const gutter = { minWidth: `${width}ch` }

  return (
    <div
      className={cn(
        // Long lines scroll sideways inside the diff rather than wrapping into
        // the gutter or widening whatever panel holds it.
        'max-h-96 overflow-auto rounded-md border border-border bg-card font-mono text-xs',
        className
      )}
    >
      <table className="w-max min-w-full border-collapse">
        <tbody>
          {parsed.hunks.map((hunk, hunkIndex) => (
            <Fragment key={`hunk-${hunkIndex}`}>
              {hunk.header && (
                <tr className="bg-sunken">
                  <td
                    colSpan={3}
                    className="select-none px-2 py-0.5 text-muted-foreground"
                  >
                    {hunk.header}
                    {hunk.heading && (
                      <span className="ml-2">{hunk.heading}</span>
                    )}
                  </td>
                </tr>
              )}
              {hunk.lines.map((line, lineIndex) => (
                <DiffRow
                  key={`${hunkIndex}-${lineIndex}`}
                  line={line}
                  gutter={gutter}
                />
              ))}
            </Fragment>
          ))}
          {omitted > 0 && (
            <tr>
              <td
                colSpan={3}
                className="px-2 py-1 text-center text-muted-foreground"
              >
                {t('common:changes.truncated', { count: omitted })}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

const ROW_TONE: Record<DiffLine['kind'], string> = {
  add: 'bg-diff-add-bg text-diff-add',
  remove: 'bg-diff-del-bg text-diff-del',
  context: '',
  meta: 'text-muted-foreground italic',
}

const MARKER: Record<DiffLine['kind'], string> = {
  add: '+',
  remove: '-',
  context: ' ',
  meta: '\\',
}

function DiffRow({
  line,
  gutter,
}: {
  line: DiffLine
  gutter: React.CSSProperties
}) {
  return (
    <tr className={ROW_TONE[line.kind]}>
      <td
        className="select-none border-r px-1.5 text-right align-top text-muted-foreground tabular-nums"
        style={gutter}
      >
        {line.oldNumber ?? ''}
      </td>
      <td
        className="select-none border-r px-1.5 text-right align-top text-muted-foreground tabular-nums"
        style={gutter}
      >
        {line.newNumber ?? ''}
      </td>
      <td className="whitespace-pre px-2 align-top">
        {/* The marker is what makes the row readable without colour. */}
        <span
          aria-hidden
          className={cn(
            'select-none pr-1',
            line.kind === 'add' && 'text-diff-add',
            line.kind === 'remove' && 'text-diff-del'
          )}
        >
          {MARKER[line.kind]}
        </span>
        {line.content}
      </td>
    </tr>
  )
}
