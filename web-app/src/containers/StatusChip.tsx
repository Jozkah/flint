import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type StatusTone =
  | 'success'
  | 'warning'
  | 'destructive'
  | 'neutral'
  | 'progress'

const TONE_CLASSES: Record<StatusTone, { chip: string; dot: string }> = {
  success: { chip: 'bg-success-tint text-success', dot: 'bg-success' },
  warning: { chip: 'bg-warning-tint text-warning', dot: 'bg-warning' },
  destructive: {
    chip: 'bg-destructive-tint text-destructive',
    dot: 'bg-destructive',
  },
  neutral: { chip: 'bg-sunken text-ink-2', dot: 'bg-muted-foreground' },
  progress: { chip: 'bg-brand-tint text-brand-text', dot: 'bg-brand' },
}

/**
 * A status label on a semantic tint (JAN Atelier): Loaded, Failed, Connected,
 * Needs authorization. The words carry the meaning; the colour only repeats it.
 * Any `aria-*`, `role` or `data-*` attribute passes through, so a live status
 * keeps its announcement and its test hook.
 */
export function StatusChip({
  tone,
  children,
  className,
  pulse,
  ...rest
}: {
  tone: StatusTone
  children: ReactNode
  className?: string
  /** Animate the dot, for a state that is still changing. */
  pulse?: boolean
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'children' | 'className'>) {
  const classes = TONE_CLASSES[tone]
  return (
    <span
      {...rest}
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium leading-5 whitespace-nowrap',
        classes.chip,
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          classes.dot,
          pulse && 'animate-pulse'
        )}
      />
      <span className="truncate">{children}</span>
    </span>
  )
}
