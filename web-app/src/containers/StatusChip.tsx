import type { ReactNode } from 'react'
import {
  Ban,
  CheckIcon,
  Clock,
  Loader2,
  OctagonAlert,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react'
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
  neutral: { chip: 'bg-muted text-fg-2', dot: 'bg-muted-foreground' },
  // Work in progress is not the accent: the accent means "selected" and marks
  // the primary action, so a running item must not look like a selected one.
  progress: { chip: 'bg-muted text-fg-2', dot: 'bg-fg-2' },
}

/**
 * A status label on a semantic tint (Flint Graphite Studio): Loaded, Failed,
 * Connected, Needs authorization. The words carry the meaning; the colour only
 * repeats it. Any `aria-*`, `role` or `data-*` attribute passes through, so a
 * live status keeps its announcement and its test hook.
 */
export function StatusChip({
  tone,
  children,
  className,
  pulse,
  wrap,
  ...rest
}: {
  tone: StatusTone
  children: ReactNode
  className?: string
  /** Animate the dot, for a state that is still changing. */
  pulse?: boolean
  /** Let a long label wrap instead of truncating (narrow panes). */
  wrap?: boolean
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'children' | 'className'>) {
  const classes = TONE_CLASSES[tone]
  return (
    <span
      {...rest}
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium leading-5',
        wrap ? 'items-baseline text-left' : 'whitespace-nowrap',
        classes.chip,
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          wrap && '-translate-y-px',
          classes.dot,
          pulse && 'motion-safe:animate-pulse'
        )}
      />
      <span className={wrap ? 'min-w-0 break-words' : 'truncate'}>
        {children}
      </span>
    </span>
  )
}

/** The states a piece of work (a run, an agent, a task, a job) can be in. */
export type WorkState =
  | 'running'
  | 'queued'
  | 'waiting'
  | 'blocked'
  | 'needs-you'
  | 'done'
  | 'failed'
  | 'cancelled'

const WORK_STATES: Record<
  WorkState,
  { icon: LucideIcon; className: string; spin?: boolean }
> = {
  running: { icon: Loader2, className: 'bg-muted text-fg-2', spin: true },
  queued: { icon: Clock, className: 'bg-muted text-muted-foreground' },
  waiting: { icon: Clock, className: 'bg-muted text-muted-foreground' },
  blocked: { icon: Ban, className: 'bg-warning-tint text-warning' },
  'needs-you': { icon: ShieldAlert, className: 'bg-warning-tint text-warning' },
  done: { icon: CheckIcon, className: 'bg-success-tint text-success' },
  failed: {
    icon: OctagonAlert,
    className: 'bg-destructive-tint text-destructive',
  },
  cancelled: { icon: Ban, className: 'bg-muted text-muted-foreground' },
}

/**
 * Work status with an icon and a word, never colour alone and never the
 * accent. Running spins only when motion is allowed. The label is required so
 * every surface says the state in its own words ("Running", "Waiting for T3").
 */
export function WorkStatus({
  state,
  children,
  className,
  wrap,
  ...rest
}: {
  state: WorkState
  children: ReactNode
  className?: string
  /** Let a long label wrap instead of truncating (narrow panes). */
  wrap?: boolean
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'children' | 'className'>) {
  const s = WORK_STATES[state]
  const Icon = s.icon
  return (
    <span
      data-state={state}
      {...rest}
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium leading-5',
        wrap ? 'items-start text-left' : 'whitespace-nowrap',
        s.className,
        className
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          'size-3.5! shrink-0',
          wrap && 'mt-0.75',
          s.spin && 'motion-safe:animate-spin'
        )}
      />
      <span className={wrap ? 'min-w-0 break-words' : 'truncate'}>
        {children}
      </span>
    </span>
  )
}
