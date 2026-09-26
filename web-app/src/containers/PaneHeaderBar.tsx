import type { ReactNode } from 'react'

/**
 * A split-view pane's one header row: its title, the page's own controls and
 * the pane's controls. Every pane that is not a Chat thread draws this row,
 * so panes side by side share one height and line up at the top. The active
 * pane's title is in the foreground colour; its content card carries the ring.
 */
export function PaneHeaderBar({
  paneId,
  isActive,
  title,
  controls,
  children,
}: {
  paneId: string
  isActive: boolean
  title: string
  /** The pane's own controls, last in the row. */
  controls: ReactNode
  /** The page's controls, between the title and the pane's. */
  children?: ReactNode
}) {
  return (
    <div
      data-testid={`conversation-pane-header-${paneId}`}
      data-active={isActive}
      className="flex h-10 shrink-0 items-center gap-2 px-3 pointer-coarse:h-12"
    >
      <h2
        data-testid={`conversation-pane-title-${paneId}`}
        title={title}
        // Not through cn(): tailwind-merge takes text-fade for a text colour
        // and drops it beside text-foreground.
        className={`text-fade min-w-0 flex-1 text-sm leading-none font-medium transition-colors ${
          isActive ? 'text-foreground' : 'text-secondary-foreground'
        }`}
      >
        {title}
      </h2>
      {children ? (
        <div className="flex min-w-0 shrink items-center gap-1.5">
          {children}
        </div>
      ) : null}
      <div className="-mr-2 flex shrink-0 items-center">{controls}</div>
    </div>
  )
}
