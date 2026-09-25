import * as React from 'react'
import { ChevronDown } from 'lucide-react'

import { cn } from '@/lib/utils'

const COLLAPSE_KEY = 'flint:frame-collapsed:'

const readCollapsed = (id: string): boolean => {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY + id) === '1'
  } catch {
    return false
  }
}

const writeCollapsed = (id: string, collapsed: boolean) => {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSE_KEY + id, '1')
    else window.localStorage.removeItem(COLLAPSE_KEY + id)
  } catch {
    // Storage unavailable: the section still toggles for this session.
  }
}

type FrameCollapse = { collapsed: boolean; toggle: () => void; bodyId: string }

const FrameCollapseContext = React.createContext<FrameCollapse | null>(null)

/**
 * The design's framed card: a muted 12px shell with a hairline, an optional
 * header row (icon, title, actions) sitting on the shell, and a white inner
 * panel holding the content. Every page section, dashboard tile and settings
 * group is a Frame, so they share edges and spacing.
 */
/**
 * `collapseId` makes the Frame collapsible: its header gains a chevron that
 * hides the body, and the choice is remembered per id in localStorage.
 */
function Frame({
  className,
  collapseId,
  ...props
}: React.ComponentProps<'section'> & { collapseId?: string }) {
  const [collapsed, setCollapsed] = React.useState(() =>
    collapseId ? readCollapsed(collapseId) : false
  )
  const bodyId = React.useId()
  const collapse = React.useMemo<FrameCollapse | null>(
    () =>
      collapseId
        ? {
            collapsed,
            bodyId,
            toggle: () =>
              setCollapsed((prev) => {
                writeCollapsed(collapseId, !prev)
                return !prev
              }),
          }
        : null,
    [collapseId, collapsed, bodyId]
  )
  const section = (
    <section
      data-slot="frame"
      data-collapsed={collapse?.collapsed ? 'true' : undefined}
      className={cn(
        'relative flex min-w-0 flex-col overflow-clip rounded-xl bg-muted p-1 shadow-[inset_0_0_0_0.8px_var(--border)] transition-[transform,box-shadow] duration-300 ease-expo',
        className
      )}
      {...props}
    />
  )
  return collapse ? (
    <FrameCollapseContext.Provider value={collapse}>
      {section}
    </FrameCollapseContext.Provider>
  ) : (
    section
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
  const collapse = React.useContext(FrameCollapseContext)
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
      {(actions || collapse) && (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {actions}
          {collapse && (
            <button
              type="button"
              onClick={collapse.toggle}
              aria-expanded={!collapse.collapsed}
              aria-controls={collapse.bodyId}
              aria-label={
                typeof title === 'string'
                  ? `${collapse.collapsed ? 'Expand' : 'Collapse'} ${title}`
                  : collapse.collapsed
                    ? 'Expand section'
                    : 'Collapse section'
              }
              data-testid="frame-collapse-toggle"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground pointer-coarse:size-11"
            >
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform duration-200',
                  collapse.collapsed && '-rotate-90'
                )}
              />
            </button>
          )}
        </div>
      )}
    </header>
  )
}

function FrameBody({
  className,
  hidden,
  ...props
}: React.ComponentProps<'div'>) {
  const collapse = React.useContext(FrameCollapseContext)
  return (
    <div
      id={collapse?.bodyId}
      hidden={hidden || collapse?.collapsed}
      data-slot="frame-body"
      className={cn(
        'relative flex min-h-px w-full flex-1 flex-col rounded-xl border-[0.8px] border-input bg-card',
        className,
        collapse?.collapsed && 'hidden'
      )}
      {...props}
    />
  )
}

export { Frame, FrameHeader, FrameBody }
