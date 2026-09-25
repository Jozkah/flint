import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { useLocation } from '@tanstack/react-router'
import { Settings } from 'lucide-react'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu, { SettingsSectionPicker } from '@/containers/SettingsMenu'
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
function useOnSettingsPage() {
  const { pathname } = useLocation()
  return areaForPath(pathname) === 'settings'
}

function SettingsSections() {
  const { t } = useTranslation()
  const onSettingsPage = useOnSettingsPage()
  if (!onSettingsPage) return null
  return (
    <Frame
      // Visible overflow: the settings-search results drop down over the
      // page, and a clipped frame would cut them off at its bottom edge.
      className="sticky top-0 hidden w-[236px] shrink-0 self-start overflow-visible lg:flex"
      aria-label={t('common:shell.sections')}
    >
      <FrameHeader icon={<Settings />} title={t('common:shell.sections')} />
      <FrameBody className="px-1 py-2">
        <SettingsMenu variant="column" />
      </FrameBody>
    </Frame>
  )
}

/** The Sections list as one button, for windows too narrow to show it. */
function CompactSections() {
  const onSettingsPage = useOnSettingsPage()
  if (!onSettingsPage) return null
  return <SettingsSectionPicker className="lg:hidden" />
}

/**
 * Two columns of settings groups placed by hand, for pages whose groups read
 * in a particular order (Appearance, Memory). Collapses to one column when
 * the content area is narrow. When the right column has nothing to show
 * (its groups are conditional), the left groups spread over both columns
 * instead of leaving half the page empty.
 */
export function SettingsColumns({
  left,
  right,
}: {
  left: ReactNode
  right: ReactNode
}) {
  if (Children.toArray(right).length === 0)
    return (
      <div className="min-w-0 gap-4 @4xl:columns-2 [&>*]:mb-4 [&>*]:break-inside-avoid">
        {Children.toArray(
          isValidElement<{ children?: ReactNode }>(left) && left.type === Fragment
            ? left.props.children
            : left
        )}
      </div>
    )
  return (
    <div className="grid min-w-0 grid-cols-1 items-start gap-4 @4xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-4">{left}</div>
      <div className="flex min-w-0 flex-col gap-4">{right}</div>
    </div>
  )
}

/**
 * The scrolling body of a settings page: the Sections frame on the left
 * (a compact section picker on narrow windows), then the page title with a
 * one-line description and the page's groups.
 *
 * Groups are laid out in two balanced columns once the content area is wide
 * enough, so a wide window is not a narrow strip of settings beside empty
 * space; a page with a single group keeps a readable measure instead.
 * `width="wide"` lets a data view (or a page that places its own
 * `SettingsColumns`) use the full width. Nothing scrolls the page sideways:
 * wide content (tables, logs) scrolls inside its own container.
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
  /** Page title above the groups. */
  title?: ReactNode
  /** One line under the title saying what the page is for. */
  description?: ReactNode
  /** Controls at the end of the title row. */
  actions?: ReactNode
  width?: 'read' | 'wide'
}) {
  // Outside the shell (tests, standalone windows) there is no section list,
  // and the router hooks it needs are not assumed to be there.
  const showSections = useHeaderSlot() !== null
  const groups = Children.toArray(children).length
  const balanced = width === 'read' && groups > 1
  return (
    <div className="h-full min-h-0 w-full overflow-x-hidden overflow-y-auto [scrollbar-width:thin]">
      <div className="flex min-w-0 items-start gap-4 px-1 pt-4 pb-[calc(2rem+env(safe-area-inset-bottom))] lg:gap-5">
        {showSections && <SettingsSections />}
        <div
          data-testid={testId}
          className="@container flex w-full min-w-0 flex-1 flex-col gap-6"
        >
          {showSections && <CompactSections />}
          {(title || description || actions) && (
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <div className="flex min-w-0 flex-col gap-3">
                {title && (
                  <h2 className="text-[22px] leading-none font-medium tracking-[-0.01em] text-foreground">
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
          <div
            className={cn(
              'min-w-0',
              balanced
                ? // Multi-column flow balances the groups by height, the
                  // way the design packs them, without measuring anything.
                  'gap-4 @4xl:columns-2 [&>*]:mb-4 [&>*]:break-inside-avoid'
                : 'flex flex-col gap-4',
              width === 'read' && !balanced && 'max-w-[52rem]'
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
