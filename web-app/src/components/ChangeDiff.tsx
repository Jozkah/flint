import { memo } from 'react'
import { cn } from '@/lib/utils'

/**
 * Tone for one line of a `write`/`edit` diff. The format comes from
 * `render_edit_diff`/`render_write_diff` in Rust: `@@ ... @@` hunk headers, then
 * `-`/`+` lines carrying their own `   N | text` line numbers.
 */
const diffLineTone = (line: string): string => {
  if (line.startsWith('@@')) return 'text-muted-foreground/60'
  if (line.startsWith('+'))
    return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (line.startsWith('-')) return 'bg-destructive/10 text-destructive'
  return 'text-muted-foreground'
}

/**
 * A `write`/`edit` diff: the change a call made, or -- in its approval prompt
 * -- the change it would make. One component for both, so what is approved
 * and what is reported afterwards look the same.
 */
export const ChangeDiff = memo(
  ({
    diff,
    className,
    label,
    testId,
  }: {
    diff: string
    className?: string
    /** Names the region for assistive technology. */
    label?: string
    testId?: string
  }) => (
    <div
      role={label ? 'region' : undefined}
      aria-label={label}
      data-testid={testId}
      className={cn(
        'mt-1.5 max-h-56 overflow-auto rounded-md border bg-card/40 py-1 font-mono text-xs',
        className
      )}
    >
      {diff.split('\n').map((line, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre-wrap wrap-break-word px-2',
            diffLineTone(line)
          )}
        >
          {line || ' '}
        </div>
      ))}
    </div>
  )
)

ChangeDiff.displayName = 'ChangeDiff'
