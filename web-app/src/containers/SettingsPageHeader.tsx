import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { useLocation } from '@tanstack/react-router'
import { Icon } from '@/components/ui/icon'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu, { SettingsSectionPicker } from '@/containers/SettingsMenu'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { showsSettingsSections } from '@/lib/shellNavigation'
import { useHeaderSlot } from '@/components/shell/HeaderSlot'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SettingsBalancedColumns } from '@/containers/SettingsBalancedColumns'

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
 * Settings pages carry their section list beside the content, and keep it for
 * every page the list itself links to. That includes MCP Servers, which the
 * sidebar also reaches as the Tools area: it used to drop the list, so a click
 * on it in the list made the list vanish. Model providers are in the list
 * too, so they keep it as well.
 */
function useOnSettingsPage() {
  const { pathname } = useLocation()
  return showsSettingsSections(pathname)
}

function SettingsSections() {
  const { t } = useTranslation()
  const onSettingsPage = useOnSettingsPage()
  if (!onSettingsPage) return null
  return (
    <Frame
      // Visible overflow: the settings-search results drop down over the
      // page, and a clipped frame would cut them off at its bottom edge.
      // Outside the scrolling column, so it stays put while the page scrolls.
      className="mt-4 hidden max-h-[calc(100%-1rem)] w-[220px] shrink-0 self-start overflow-visible lg:flex"
      aria-label={t('common:shell.sections')}
    >
      <FrameHeader
        icon={<Icon name="sb-settings" size={16} />}
        title={t('common:shell.sections')}
      />
      <FrameBody className="p-2">
        <SettingsMenu variant="column" />
      </FrameBody>
    </Frame>
  )
}

/**
 * The Sections list beside a page that lays itself out (an engine page rather
 * than a settings body), so the list stays when that page is opened from it.
 */
export function SettingsWithSections({ children }: { children: ReactNode }) {
  const showSections = useHeaderSlot() !== null
  return (
    <div className="flex h-full min-h-0 w-full gap-5 pl-1">
      {showSections && <SettingsSections />}
      <div className="h-full min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** The Sections list as one button, for windows too narrow to show it. */
function CompactSections() {
  const onSettingsPage = useOnSettingsPage()
  if (!onSettingsPage) return null
  return <SettingsSectionPicker className="lg:hidden" />
}

function flatten(node: ReactNode) {
  return Children.toArray(
    isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment
      ? node.props.children
      : node
  )
}

/**
 * Two columns of settings groups for pages whose groups read in a particular
 * order (Memory): `left` then `right` is the source (and tab) order, and the
 * groups are packed whole into the shorter column by height, so neither
 * column leaves blank space under it. Collapses to one column when the
 * content area is narrow.
 */
export function SettingsColumns({
  left,
  right,
}: {
  left: ReactNode
  right: ReactNode
}) {
  return (
    <SettingsBalancedColumns>
      {[...flatten(left), ...flatten(right)]}
    </SettingsBalancedColumns>
  )
}

type PlacedGroup = { child: ReactNode; col: 0 | 1 | 2; at: number }

/** Runs of column groups, with each full-width group standing alone between them. */
function segments(items: PlacedGroup[]) {
  const out: { full: boolean; items: PlacedGroup[] }[] = []
  for (const item of items) {
    const full = item.col === 2
    const last = out[out.length - 1]
    if (!full && last && !last.full) last.items.push(item)
    else out.push({ full, items: [item] })
  }
  return out
}

/**
 * The scrolling body of a settings page: the Sections frame on the left
 * (a compact section picker on narrow windows), then the page title with a
 * one-line description and the page's groups.
 *
 * `layout` places the groups in two columns by hand, one entry per group
 * (0 = left, 1 = right, 2 = a full-width group that splits the columns into
 * a row above and a row below), the order the design reads them in. Without it,
 * several groups flow into two columns balanced by height, and a single
 * group spans the page, as the design draws it. Below the two-column width every layout
 * collapses to one column in the groups' own order. `width="wide"` lets a
 * data view use the full width. Nothing scrolls the page sideways: wide
 * content (tables, logs) scrolls inside its own container.
 */
export function SettingsPageBody({
  children,
  testId,
  title,
  description,
  actions,
  width = 'read',
  layout,
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
  /** Column (0 or 1) of each group, in order; 2 spans both columns. */
  layout?: readonly (0 | 1 | 2)[]
}) {
  // Outside the shell (tests, standalone windows) there is no section list,
  // and the router hooks it needs are not assumed to be there.
  const showSections = useHeaderSlot() !== null
  // Positions count empty slots (`{cond && <Card />}`), so a layout entry
  // stays with its group whether or not an earlier one is shown.
  const items: { child: ReactNode; col: 0 | 1 | 2; at: number }[] = []
  Children.forEach(children, (child, at) => {
    if (child == null || typeof child === 'boolean') return
    items.push({ child, col: layout?.[at] ?? 0, at })
  })
  const placed = layout && items.length > 1
  const balanced = !placed && width === 'read' && items.length > 1
  return (
    // The Sections frame sits beside the scrolling column, not inside it:
    // inside, it slid up with the page before sticking (and scrolled away on
    // a short window). Only the page's own content scrolls.
    <div className="flex h-full min-h-0 w-full gap-5 pl-1">
      {showSections && <SettingsSections />}
      <div className="-mr-3 h-full min-h-0 w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto pr-4 [scrollbar-width:thin]">
      <div className="flex min-w-0 items-start pt-4 pb-[calc(2rem+env(safe-area-inset-bottom))]">
        <div
          data-testid={testId}
          className="@container flex w-full min-w-0 flex-1 flex-col gap-3.5"
        >
          {showSections && <CompactSections />}
          {(title || description || actions) && (
            <div className="flex flex-wrap items-start justify-between gap-4 pt-0.5 pb-1">
              <div className="flex min-w-0 flex-col gap-4 leading-none">
                {title && (
                  <h2 className="text-2xl leading-none font-medium text-foreground">
                    {title}
                  </h2>
                )}
                {description && (
                  <p className="text-[length:calc(var(--ui-font-base)*0.8125)] leading-[1.35] text-muted-foreground">
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
          {placed ? (
            <div className="flex min-w-0 flex-col gap-4">
              {segments(items).map((seg, i) =>
                seg.full ? (
                  // A full-width group: one column at every width.
                  <div key={`full-${i}`} className="min-w-0">
                    {seg.items[0].child}
                  </div>
                ) : (
                  // Whole groups packed into the shorter column by height; DOM
                  // and tab order stay the source order.
                  <SettingsBalancedColumns key={`cols-${i}`}>
                    {seg.items.map(({ child }) => child)}
                  </SettingsBalancedColumns>
                )
              )}
            </div>
          ) : balanced ? (
            <SettingsBalancedColumns>
              {items.map(({ child }) => child)}
            </SettingsBalancedColumns>
          ) : (
            <div className="flex min-w-0 flex-col gap-4">{children}</div>
          )}
        </div>
      </div>
      </div>
    </div>
  )
}
