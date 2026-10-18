import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Icon } from '@/components/ui/icon'
import { SidebarItemIcon } from '@/components/shell/SidebarItemIcon'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import {
  SIDEBAR_ITEMS,
  SIDEBAR_SECTIONS,
  isSidebarItemHidden,
  type SidebarSection,
} from '@/lib/sidebarItems'

const itemsOf = (section: SidebarSection) =>
  SIDEBAR_ITEMS.filter((item) => item.section === section)

/**
 * One switch per sidebar destination, grouped as the sidebar groups them, with
 * a small live preview of what stays. Used by Settings -> Appearance and by
 * the first-run guide, so both change the same saved list.
 */
export function SidebarItemsPicker({ preview = true }: { preview?: boolean }) {
  const { t } = useTranslation()
  const hidden = useInterfaceSettings((s) => s.hiddenNavItems)
  const setHidden = useInterfaceSettings((s) => s.setNavItemHidden)
  const showAll = useInterfaceSettings((s) => s.showAllNavItems)
  const anyHidden = SIDEBAR_ITEMS.some((i) => isSidebarItemHidden(hidden, i.id))

  return (
    <div data-testid="sidebar-items-picker" className="@container flex flex-col gap-3 pb-2">
      {/* The switches take two columns once the card is wide enough, and the
          preview moves beside them (staying in view) when there is room for
          both; on a narrow card everything stacks in one column. */}
      <div className="flex flex-col gap-3 @min-[46rem]:grid @min-[46rem]:grid-cols-[minmax(0,1fr)_15rem] @min-[46rem]:items-start @min-[46rem]:gap-6">
        <div
          data-testid="sidebar-items-columns"
          className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-3 @min-[30rem]:grid-cols-2"
        >
          {SIDEBAR_SECTIONS.map((section) => (
            <section key={section} aria-labelledby={`sidebar-items-${section}`}>
              <h4
                id={`sidebar-items-${section}`}
                className="px-1 text-[11px] font-medium tracking-wide text-subtle-foreground"
              >
                {t(`settings:sidebarItems.section.${section}`)}
              </h4>
              <ul className="mt-1 flex flex-col">
                {itemsOf(section).map((item) => {
                  const label = t(item.labelKey)
                  const shown = !isSidebarItemHidden(hidden, item.id)
                  return (
                    <li
                      key={item.id}
                      className="flex min-h-8 items-center gap-2.5 rounded-md px-1 py-1"
                    >
                      <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&>svg]:size-4">
                        <SidebarItemIcon item={item} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={label}>
                        {label}
                      </span>
                      {item.canHide ? (
                        <Switch
                          aria-label={t('settings:sidebarItems.showItem', {
                            item: label,
                          })}
                          data-testid={`sidebar-item-switch-${item.id}`}
                          checked={shown}
                          onCheckedChange={(on) => setHidden(item.id, !on)}
                        />
                      ) : (
                        <span className="text-xs text-subtle-foreground">
                          {t('settings:sidebarItems.alwaysShown')}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
        {preview && <SidebarPreview hidden={hidden} />}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {t('settings:sidebarItems.reachable')}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          data-testid="sidebar-items-show-all"
          disabled={!anyHidden}
          onClick={showAll}
        >
          {t('settings:sidebarItems.showAll')}
        </Button>
      </div>
    </div>
  )
}

/** The sidebar as it will look: what is left of each group, in order. */
function SidebarPreview({ hidden }: { hidden: string[] }) {
  const { t } = useTranslation()
  const rows = SIDEBAR_ITEMS.filter(
    (item) => item.section !== 'header' && !isSidebarItemHidden(hidden, item.id)
  )
  const settings = SIDEBAR_ITEMS.find((i) => i.id === 'settings')
  const overviewShown = !isSidebarItemHidden(hidden, 'overview')
  return (
    <div
      role="group"
      aria-label={t('settings:sidebarItems.preview')}
      data-testid="sidebar-items-preview"
      className="grid w-full grid-cols-2 content-start gap-x-3 gap-y-0.5 rounded-lg border-[0.8px] border-border bg-muted/50 p-2 @min-[46rem]:sticky @min-[46rem]:top-2 @min-[46rem]:grid-cols-1"
    >
      <div className="col-span-full flex w-full items-center justify-between px-1.5 pb-1 text-[11px] font-medium tracking-wide text-subtle-foreground">
        <span>{t('settings:sidebarItems.preview')}</span>
        {overviewShown && <Icon name="sb-dashboard" />}
      </div>
      {SIDEBAR_SECTIONS.filter((s) => s !== 'header').map((section) => {
        const visible = rows.filter((row) => row.section === section)
        if (visible.length === 0) return null
        return (
          <div key={section} className="contents">
            {visible.map((item) => (
              <div
                key={item.id}
                data-testid={`sidebar-preview-${item.id}`}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[0.8125rem] text-secondary-foreground [&>span>svg]:size-3.5"
              >
                <span className="grid size-3.5 shrink-0 place-items-center text-muted-foreground">
                  <SidebarItemIcon item={item} />
                </span>
                <span className="truncate">{t(item.labelKey)}</span>
              </div>
            ))}
          </div>
        )
      })}
      {settings && (
        <div
          data-testid="sidebar-preview-settings"
          className="col-span-full flex items-center gap-2 px-1.5 py-1 text-[0.8125rem] text-secondary-foreground"
        >
          <span className="grid size-3.5 shrink-0 place-items-center text-muted-foreground [&>svg]:size-3.5">
            <Icon name={settings.icon} />
          </span>
          <span className="truncate">{t(settings.labelKey)}</span>
        </div>
      )}
    </div>
  )
}
