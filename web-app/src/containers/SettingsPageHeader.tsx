import type { ReactNode } from 'react'
import { useLocation } from '@tanstack/react-router'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { areaForPath } from '@/lib/shellNavigation'
import { useHeaderSlot } from '@/components/shell/HeaderSlot'
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
  // The top header's breadcrumb names the page; the title stays for screen
  // readers and for the standalone bar outside the shell.
  return (
    <HeaderPage>
      <h1 className="sr-only">
        <span>{t('common:settings')}</span>
        {title ? <span> · {title}</span> : null}
      </h1>
      {children && (
        <div className="relative z-50 ml-auto flex shrink-0 items-center gap-2">
          {children}
        </div>
      )}
    </HeaderPage>
  )
}

/**
 * Settings pages carry their section list beside the content; engine pages
 * that reuse the settings body (models, tools) are reached from the sidebar
 * instead, so they show none.
 */
function SettingsSections() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  if (areaForPath(pathname) !== 'settings') return null
  return (
    <Frame className="hidden w-60 shrink-0 lg:flex" aria-label={t('common:shell.sections')}>
      <FrameHeader title={t('common:shell.sections')} />
      <FrameBody className="min-h-0 overflow-hidden py-1">
        <SettingsMenu variant="column" />
      </FrameBody>
    </Frame>
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
  const inShell = useHeaderSlot() !== null
  return (
    <div className="flex h-[calc(100%-var(--ctx-h))] min-h-0 gap-4 pb-3">
      {inShell && <SettingsSections />}
      <div
        data-testid={testId}
        className="w-full min-w-0 overflow-x-hidden overflow-y-auto px-1 pt-1 pb-[calc(2rem+env(safe-area-inset-bottom))] md:px-2"
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
                  <p className="text-[13px] leading-normal text-muted-foreground">
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
