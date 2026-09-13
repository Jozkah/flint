import type { ReactNode } from 'react'
import HeaderPage from '@/containers/HeaderPage'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * The context bar of a settings page: the page identity in the display face,
 * and the page's primary actions at the end. Window-control insets are
 * reserved by HeaderPage itself, so nothing here pads for them.
 */
export function SettingsPageHeader({ children }: { children?: ReactNode }) {
  const { t } = useTranslation()
  return (
    <HeaderPage>
      <div className="flex w-full min-w-0 items-center justify-between gap-3">
        <h1 className="truncate font-display text-xl font-normal leading-none text-foreground">
          {t('common:settings')}
        </h1>
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
 * measure on wide screens and never scrolls the page sideways; wide content
 * (tables, logs) scrolls inside its own container.
 */
export function SettingsPageBody({
  children,
  testId,
}: {
  children: ReactNode
  testId?: string
}) {
  return (
    <div className="flex h-[calc(100%-var(--ctx-h))] min-h-0">
      <div
        data-testid={testId}
        className="w-full min-w-0 overflow-x-hidden overflow-y-auto px-3 py-4 md:px-6 md:py-6"
      >
        <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4">
          {children}
        </div>
      </div>
    </div>
  )
}
