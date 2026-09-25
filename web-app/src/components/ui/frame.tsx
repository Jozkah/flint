import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The design's framed card: a muted 12px shell with a hairline, an optional
 * header row (icon, title, actions) sitting on the shell, and a white inner
 * panel holding the content. Every page section, dashboard tile and settings
 * group is a Frame, so they share edges and spacing.
 */
function Frame({
  className,
  ...props
}: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="frame"
      className={cn(
        'relative flex min-w-0 flex-col overflow-clip rounded-xl bg-muted p-1 shadow-[inset_0_0_0_0.8px_var(--border)] transition-[transform,box-shadow] duration-300 ease-expo',
        className
      )}
      {...props}
    />
  )
}

function FrameHeader({
  className,
  icon,
  title,
  actions,
  children,
  ...props
}: Omit<React.ComponentProps<'header'>, 'title'> & {
  icon?: React.ReactNode
  title?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <header
      data-slot="frame-header"
      className={cn(
        'relative flex w-full shrink-0 items-center justify-between gap-2 p-2',
        className
      )}
      {...props}
    >
      {(icon || title) && (
        <div className="flex min-w-0 items-center gap-3">
          {icon && (
            <span className="flex shrink-0 text-muted-foreground [&_svg:not([class*='size-'])]:size-4">
              {icon}
            </span>
          )}
          {title && (
            <h2 className="truncate text-sm leading-none font-medium text-secondary-foreground">
              {title}
            </h2>
          )}
        </div>
      )}
      {children}
      {actions && (
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </header>
  )
}

function FrameBody({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="frame-body"
      className={cn(
        'relative flex min-h-px w-full flex-1 flex-col rounded-xl border-[0.8px] border-input bg-card',
        className
      )}
      {...props}
    />
  )
}

export { Frame, FrameHeader, FrameBody }
