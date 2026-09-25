import type { ReactNode } from 'react'
import HeaderPage from '@/containers/HeaderPage'
import { useHeaderSlot } from '@/components/shell/HeaderSlot'

type SystemPageHeaderProps = {
  title: ReactNode
  icon?: ReactNode
  actions?: ReactNode
}

/**
 * The context bar for the System pages (system monitor and logs).
 *
 * These routes render in two places: inside the shell, where the page owns the
 * 52px context bar, and in their own window without the shell (`LogsLayout`),
 * where there is no sidebar, no navigation sheet and no window-control inset to
 * clear. Outside the shell the same row is drawn as a plain bar so the page
 * still reads as part of Flint.
 */
export function SystemPageHeader({ title, icon, actions }: SystemPageHeaderProps) {
  const inShell = useHeaderSlot() !== null

  const row = (
    <div className="flex w-full min-w-0 items-center gap-2">
      {icon && (
        <span className="shrink-0 text-muted-foreground" aria-hidden>
          {icon}
        </span>
      )}
      <h1 className="min-w-0 truncate text-sm font-semibold text-foreground">
        {title}
      </h1>
      {actions && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {actions}
        </div>
      )}
    </div>
  )

  // In the shell the breadcrumb already names the page; only its actions
  // join the top header.
  if (inShell)
    return actions ? (
      <HeaderPage>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>
      </HeaderPage>
    ) : null

  return (
    <header
      data-testid="system-page-bar"
      className="flex h-[52px] shrink-0 items-center border-b border-border bg-card px-3 md:px-6"
    >
      {row}
    </header>
  )
}
