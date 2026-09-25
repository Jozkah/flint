import { useMemo } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import {
  Bell,
  LayoutGrid,
  Loader2,
  Menu,
  Moon,
  PanelLeft,
  Settings,
  ShieldAlert,
  Sun,
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useShellNav } from '@/components/shell/nav-kit'
import { useHeaderSlot } from '@/components/shell/HeaderSlot'
import { crumbForPath } from '@/lib/breadcrumb'
import { route } from '@/constants/routes'
import { useTheme } from '@/hooks/useTheme'
import { useThreads } from '@/hooks/useThreads'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getProviderTitle, cn } from '@/lib/utils'
import { useTitlebarLayout } from '@/stores/titlebar-layout-store'
import {
  appDrawnButtonCounts,
  detectMacOverlay,
  detectWindowChrome,
  headerDragsWindow,
  resolveHeaderInset,
} from '@/lib/titlebar'

const iconBtn =
  'grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-secondary-foreground transition-[background-color,color,transform] duration-150 ease-expo outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.94] data-[state=open]:bg-accent [&>svg]:size-4'

function useCurrentName(crumb: ReturnType<typeof crumbForPath>) {
  const thread = useThreads((s) =>
    crumb.dynamic === 'thread' && crumb.param ? s.threads[crumb.param] : undefined
  )
  const { folders } = useThreadManagement()
  const providers = useModelProvider((s) => s.providers)
  if (crumb.dynamic === 'thread') return thread?.title
  if (crumb.dynamic === 'project')
    return folders.find((f) => f.id === crumb.param)?.name
  if (crumb.dynamic === 'provider') {
    const p = providers.find((x) => x.provider === crumb.param)
    return p ? getProviderTitle(p.provider) : crumb.param
  }
  return undefined
}

/**
 * The 52px header above every page: sidebar toggle, "Section / Page", the
 * page's own controls (portalled in by HeaderPage), live-work chips and the
 * theme, activity and settings buttons. Where Flint draws its own window
 * chrome the empty header drags the window, and it keeps clear of the window
 * controls.
 */
export function TopHeader() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const { open, toggle, isMobile, setOpenMobile } = useShellNav()
  const headerSlot = useHeaderSlot()
  const crumb = crumbForPath(pathname)
  const dynamicName = useCurrentName(crumb)
  const current = crumb.currentKey ? t(crumb.currentKey) : (dynamicName || t('common:newThread'))

  const isDark = useTheme((s) => s.isDark)
  const setTheme = useTheme((s) => s.setTheme)
  const runs = useCoworkRun((s) => Object.keys(s.runs ?? {}).length)
  const approvals = useToolApprovalRequests((s) => Object.keys(s.pending ?? {}).length)

  const layoutLeft = useTitlebarLayout((s) => s.layout.left.length)
  const layoutRight = useTitlebarLayout((s) => s.layout.right.length)
  const macOverlay = useMemo(() => detectMacOverlay(), [])
  const chrome = useMemo(() => detectWindowChrome({ macOverlay }), [macOverlay])
  const buttons = appDrawnButtonCounts(chrome, { left: layoutLeft, right: layoutRight })
  const inset = resolveHeaderInset({
    macOverlay,
    sidebarOpen: open && !isMobile,
    leftButtonCount: buttons.left,
    rightButtonCount: buttons.right,
  })
  const drags = headerDragsWindow(chrome)
  const dragRegion = drags ? { 'data-tauri-drag-region': true } : {}

  return (
    <header
      {...dragRegion}
      data-testid="context-bar"
      className={cn(
        'flex h-[52px] w-full shrink-0 items-center gap-3 px-3',
        inset.macLeftPad && 'pl-24'
      )}
      style={{
        ...(inset.leftPx ? { paddingLeft: inset.leftPx } : {}),
        ...(inset.rightPx ? { paddingRight: inset.rightPx } : {}),
      }}
    >
      {isMobile ? (
        <button
          type="button"
          className={cn(iconBtn, 'pointer-coarse:size-11')}
          onClick={() => setOpenMobile(true)}
          aria-label={t('common:shell.openNavigation')}
          data-testid="open-navigation"
        >
          <Menu />
        </button>
      ) : (
        !open && (
          <button
            type="button"
            className={iconBtn}
            onClick={toggle}
            aria-label={t('common:shell.expandSidebar')}
            title={t('common:shell.expandSidebar')}
          >
            <PanelLeft />
          </button>
        )
      )}

      <nav
        aria-label={t('common:shell.breadcrumb')}
        className="flex min-w-0 shrink items-center gap-2 text-sm leading-none"
        {...dragRegion}
      >
        <Link
          to={crumb.parentTo}
          className="group/bc flex shrink-0 items-center gap-2 rounded-md text-muted-foreground transition-colors outline-hidden hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <LayoutGrid className="size-4" aria-hidden />
          <span className="hidden sm:inline">{t(crumb.parentKey)}</span>
        </Link>
        <span aria-hidden className="text-subtle-foreground">/</span>
        <span aria-current="page" className="truncate font-medium text-foreground" title={current}>
          {current}
        </span>
      </nav>

      <div
        ref={headerSlot?.setSlot}
        {...dragRegion}
        data-testid="header-slot"
        className="flex h-full min-w-0 flex-1 items-center gap-2"
      />

      <div className="flex shrink-0 items-center gap-1.5">
        {runs > 0 && (
          <Link
            to={route.cowork}
            className="hidden h-[26px] items-center gap-1.5 rounded-full border-[0.8px] border-border bg-card px-2.5 text-[11.5px] font-medium whitespace-nowrap text-secondary-foreground transition-shadow hover:shadow-lift md:inline-flex"
            title={t('common:shell.runsTitle')}
            data-testid="header-runs-chip"
          >
            <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden />
            {t('common:shell.runs', { count: runs })}
          </Link>
        )}
        {approvals > 0 && (
          <span
            role="status"
            className="hidden h-[26px] items-center gap-1.5 rounded-full border-[0.8px] border-warning/35 bg-warning/8 px-2.5 text-[11.5px] font-medium whitespace-nowrap text-warning md:inline-flex"
            data-testid="header-approvals-chip"
          >
            <ShieldAlert className="size-3" aria-hidden />
            {t('common:shell.approvals', { count: approvals })}
          </span>
        )}
        <button
          type="button"
          className={iconBtn}
          onClick={() => void setTheme(isDark ? 'light' : 'dark')}
          aria-label={isDark ? t('common:shell.lightMode') : t('common:shell.darkMode')}
          title={isDark ? t('common:shell.lightMode') : t('common:shell.darkMode')}
          data-testid="header-theme"
        >
          {isDark ? <Sun /> : <Moon />}
        </button>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(iconBtn, 'relative')}
              aria-label={t('common:shell.activity')}
              title={t('common:shell.activity')}
              data-testid="header-activity"
            >
              <Bell className="origin-top transition-transform duration-500 ease-expo hover:[animation:ring_.6s_ease]" />
              {(approvals > 0 || runs > 0) && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-1 right-1 size-1.5 rounded-full',
                    approvals > 0 ? 'bg-warning' : 'bg-info'
                  )}
                />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-1.5">
            <p className="px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-[.025em] text-subtle-foreground uppercase">
              {t('common:shell.activity')}
            </p>
            {approvals === 0 && runs === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {t('common:shell.nothingNeedsYou')}
              </p>
            ) : (
              <div className="flex flex-col">
                {approvals > 0 && (
                  <div className="flex items-center gap-2 rounded-lg px-2 py-2 text-[0.8125rem] text-foreground">
                    <ShieldAlert className="size-4 text-warning" aria-hidden />
                    {t('common:shell.approvals', { count: approvals })}
                  </div>
                )}
                {runs > 0 && (
                  <Link
                    to={route.cowork}
                    className="flex items-center gap-2 rounded-lg px-2 py-2 text-[0.8125rem] text-foreground hover:bg-accent"
                  >
                    <Loader2 className="size-4 text-info motion-safe:animate-spin" aria-hidden />
                    {t('common:shell.runs', { count: runs })}
                  </Link>
                )}
              </div>
            )}
          </PopoverContent>
        </Popover>
        <Link
          to={route.settings.general}
          className={cn(iconBtn, 'group/set')}
          aria-label={t('common:settings')}
          title={t('common:settings')}
        >
          <Settings className="transition-transform duration-500 ease-expo group-hover/set:rotate-90" />
        </Link>
      </div>
    </header>
  )
}
