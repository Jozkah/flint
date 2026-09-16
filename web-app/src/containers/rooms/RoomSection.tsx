import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * One titled card in the room side panel. Groups a set of related controls
 * behind a clear heading and optional description so the panel reads as a few
 * distinct sections rather than one long wall of fields. Sits on the panel's
 * muted background as a raised `bg-card` surface, which is what gives the
 * grouping its visual edge.
 */
export function RoomSection({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
  ...rest
}: {
  title?: ReactNode
  description?: ReactNode
  /** A control aligned to the right of the heading, e.g. a toggle. */
  action?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        'rounded-xl border border-border bg-card p-4 shadow-xs',
        className
      )}
      {...rest}
    >
      {(title || action) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          {title && (
            <div className="min-w-0">
              <h3 className="text-sm font-semibold leading-tight text-foreground">
                {title}
              </h3>
              {description && (
                <p className="mt-1 text-xs leading-snug text-muted-foreground">
                  {description}
                </p>
              )}
            </div>
          )}
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      <div className={cn('flex min-w-0 flex-col gap-4', contentClassName)}>
        {children}
      </div>
    </section>
  )
}
