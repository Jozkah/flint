import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Centred empty state: an icon tile, a one-line title, a short hint and an
 * optional action. Used wherever a list or panel has nothing to show yet.
 */
function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'title'> & {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex w-full flex-1 flex-col items-center justify-center gap-1.5 px-4 py-8 text-center motion-safe:animate-rise-in',
        className
      )}
      {...props}
    >
      {icon && (
        <span className="mb-2 grid size-10 place-items-center rounded-xl bg-card text-muted-foreground shadow-lift [&_svg:not([class*='size-'])]:size-4.5">
          {icon}
        </span>
      )}
      <p className="text-[0.8125rem] font-medium text-foreground">{title}</p>
      {description && (
        <p className="max-w-xs text-xs text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export { EmptyState }
