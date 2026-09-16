import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * One titled card in the room side panel. Groups related controls behind a
 * clear heading and optional description so the panel reads as a few distinct
 * sections rather than one long wall of fields. Sits on the panel's muted
 * background as a raised `bg-card` surface, which is what gives the grouping
 * its visual edge.
 *
 * With `collapsible`, the card becomes a native `<details>` disclosure: the
 * heading is the summary and the body folds away, so the side panel is a short
 * stack of headers the user opens one at a time instead of a tall wall. A
 * plain (non-collapsible) card keeps the static heading, for sections that are
 * always shown, like the room controls.
 */
export function RoomSection({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
  collapsible,
  defaultOpen,
  ...rest
}: {
  title?: ReactNode
  description?: ReactNode
  /** A control aligned to the right of the heading, e.g. a toggle. */
  action?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
  /** Fold the body behind its heading. */
  collapsible?: boolean
  /** Start open when collapsible. Ignored otherwise. */
  defaultOpen?: boolean
} & React.HTMLAttributes<HTMLElement>) {
  const cardClass = cn('rounded-xl border border-border bg-card shadow-xs', className)
  const body = <div className={cn('flex min-w-0 flex-col gap-4', contentClassName)}>{children}</div>

  if (collapsible) {
    return (
      <details className={cn('group', cardClass)} open={defaultOpen} {...rest}>
        <summary className="flex cursor-pointer list-none items-start justify-between gap-3 rounded-xl p-4 outline-hidden hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-tight text-foreground">{title}</h3>
            {description && (
              <p className="mt-1 text-xs leading-snug text-muted-foreground">{description}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {action}
            <ChevronDown
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
            />
          </div>
        </summary>
        <div className="px-4 pb-4">{body}</div>
      </details>
    )
  }

  return (
    <section className={cn('p-4', cardClass)} {...rest}>
      {(title || action) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          {title && (
            <div className="min-w-0">
              <h3 className="text-sm font-semibold leading-tight text-foreground">{title}</h3>
              {description && (
                <p className="mt-1 text-xs leading-snug text-muted-foreground">{description}</p>
              )}
            </div>
          )}
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      {body}
    </section>
  )
}
