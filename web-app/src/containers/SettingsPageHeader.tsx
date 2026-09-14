import type { ReactNode } from 'react'
import HeaderPage from '@/containers/HeaderPage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

/**
 * The context bar of a settings page: "Settings · Page" in the compact
 * 46px header, and the page's primary actions at the end. Window-control
 * insets are reserved by HeaderPage itself, so nothing here pads for them.
 */
export function SettingsPageHeader({
  children,
  title,
}: {
  children?: ReactNode
  /** The current page, shown after "Settings". */
  title?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <HeaderPage>
      <div className="flex w-full min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-1.5 truncate text-sm">
          <h1 className="shrink-0 font-semibold text-foreground">
            {t('common:settings')}
          </h1>
          {title && (
            <span className="truncate text-muted-foreground">
              <span aria-hidden>· </span>
              {title}
            </span>
          )}
        </div>
        {children && (
          <div className="relative z-50 flex shrink-0 items-center gap-2">
            {children}
          </div>
        )}
      </div>
    </HeaderPage>
  )
}

/**
 * The scrolling body under the context bar. Content is held to a readable
 * column (about 50rem) with a compact page title and a one-line description;
 * nothing scrolls the page sideways, so wide content (tables, logs) scrolls
 * inside its own container. `width="wide"` lets a data view grow with the
 * window instead.
 */
export function SettingsPageBody({
  children,
  testId,
  title,
  description,
  actions,
  width = 'read',
}: {
  children: ReactNode
  testId?: string
  /** Compact page title (`text-base font-semibold`). */
  title?: ReactNode
  /** One line under the title saying what the page is for. */
  description?: ReactNode
  /** Controls at the end of the title row. */
  actions?: ReactNode
  width?: 'read' | 'wide'
}) {
  return (
    <div className="flex h-[calc(100%-var(--ctx-h))] min-h-0">
      <div
        data-testid={testId}
        className="w-full min-w-0 overflow-x-hidden overflow-y-auto px-4 pt-5 pb-[calc(2rem+env(safe-area-inset-bottom))] md:px-7 md:pt-6"
      >
        <div
          className={cn(
            'mx-auto flex w-full min-w-0 flex-col gap-4',
            width === 'read' ? 'max-w-[50rem]' : 'max-w-[1400px]'
          )}
        >
          {(title || description || actions) && (
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0 space-y-0.5">
                {title && (
                  <h2 className="text-base font-semibold text-foreground">
                    {title}
                  </h2>
                )}
                {description && (
                  <p className="text-[13px] leading-normal text-ink-2">
                    {description}
                  </p>
                )}
              </div>
              {actions && (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {actions}
                </div>
              )}
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}
