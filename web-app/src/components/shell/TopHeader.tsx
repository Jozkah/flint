import { useMemo } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  Loader2,
  Menu,
  ShieldAlert,
} from 'lucide-react'
import { Icon, type IconName } from '@/components/ui/icon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useUsageStats, type ActivityKind } from '@/stores/usage-stats-store'
import { useShellNav } from '@/components/shell/nav-kit'
import { useHeaderSlot } from '@/components/shell/HeaderSlot'
import { crumbForPath } from '@/lib/breadcrumb'
import { route } from '@/constants/routes'
import { useTheme } from '@/hooks/useTheme'
import { useThreads } from '@/hooks/useThreads'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useRoomsState } from '@/containers/rooms/roomsBindings'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
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
  const { summaries } = useRoomsState()
  const sessionTitle = useCoworkSessions((s) =>
    crumb.dynamic === 'session'
      ? s.sessions.find((x) => x.id === s.currentId)?.title
      : undefined
  )
  if (crumb.dynamic === 'session') return sessionTitle
  if (crumb.dynamic === 'thread') return thread?.title
  if (crumb.dynamic === 'room')
    return summaries.find((r) => r.id === crumb.param)?.title
  if (crumb.dynamic === 'project')
    return folders.find((f) => f.id === crumb.param)?.name
  if (crumb.dynamic === 'provider') {
    const p = providers.find((x) => x.provider === crumb.param)
    return p ? getProviderTitle(p.provider) : crumb.param
  }
  return undefined
}

const NOTIF_ICON: Partial<Record<ActivityKind, IconName>> = {
  'tool-approved': 'feed-ticket',
  'tool-denied': 'feed-alert',
  'tool-failed': 'feed-alert',
  'model-loaded': 'feed-star',
  'model-swapped': 'feed-repeat',
  compaction: 'feed-book',
  'run-finished': 'feed-ticket',
  knowledge: 'feed-book',
  warning: 'feed-alert',
}

/** One notification: the design's feed icon, a title and a detail line. */
function NotifRow({
  icon,
  title,
  detail,
  onSelect,
}: {
  icon: IconName
  title: string
  detail?: string
  onSelect?: () => void
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="items-start gap-2.5 p-2">
      <Icon name={icon} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <b className="text-[0.8125rem] font-medium text-foreground">{title}</b>
        {detail && <small className="truncate text-xs text-muted-foreground">{detail}</small>}
      </span>
    </DropdownMenuItem>
  )
}

/**
 * Switch theme with the design's reveal: the new theme opens as a circle from
 * the toggle (View Transitions), or switches at once without motion.
 */
function switchTheme(
  from: HTMLElement,
  next: 'light' | 'dark',
  setTheme: (t: 'light' | 'dark') => unknown
) {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> }
  }
  const reduce = document.documentElement.classList.contains('reduce-motion')
  if (reduce || !doc.startViewTransition) {
    void setTheme(next)
    return
  }
  const r = from.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  document.documentElement.classList.add('vt-theme')
  const t = doc.startViewTransition(() => {
    void setTheme(next)
    document.documentElement.classList.toggle('dark', next === 'dark')
  })
  t.ready
    .then(() =>
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
        { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)', pseudoElement: '::view-transition-new(root)' }
      )
    )
    .catch(() => {})
  t.finished.finally(() => document.documentElement.classList.remove('vt-theme'))
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
  const current = crumb.currentKey
    ? t(crumb.currentKey)
    : dynamicName ||
      (crumb.dynamic === 'room'
        ? t('common:appRail.rooms')
        : crumb.dynamic === 'thread'
          ? t('common:newThread')
          : crumb.dynamic === 'session'
            ? t('common:newSession')
          : (crumb.param ?? ''))

  const isDark = useTheme((s) => s.isDark)
  const setTheme = useTheme((s) => s.setTheme)
  const runs = useCoworkRun((s) => Object.keys(s.runs ?? {}).length)
  const approvals = useToolApprovalRequests((s) => Object.keys(s.pending ?? {}).length)
  const navigate = useNavigate()
  const activity = useUsageStats((s) => s.activity)
  const recent = activity.slice(0, 4)

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
            <Icon name="sidebar-right" className="rotate-180" />
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
          <Icon name="hd-dashboard" />
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
        className="flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden"
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
          className={cn(iconBtn, 'max-sm:hidden')}
          onClick={(e) => switchTheme(e.currentTarget, isDark ? 'light' : 'dark', setTheme)}
          aria-label={isDark ? t('common:shell.lightMode') : t('common:shell.darkMode')}
          title={isDark ? t('common:shell.lightMode') : t('common:shell.darkMode')}
          data-testid="header-theme"
        >
          <Icon name={isDark ? 'x-sun' : 'x-moon'} />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(iconBtn, 'group/bell relative')}
              aria-label={t('common:shell.notifications')}
              title={t('common:shell.notifications')}
              data-testid="header-activity"
            >
              <span className="inline-flex origin-top group-hover/bell:[animation:ring_.6s_ease]">
                <Icon name="bell" />
              </span>
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
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <DropdownMenuLabel>{t('common:shell.notifications')}</DropdownMenuLabel>
            {approvals === 0 && runs === 0 && recent.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {t('common:shell.nothingNeedsYou')}
              </p>
            ) : (
              <>
                {approvals > 0 && (
                  <NotifRow icon="feed-alert" title={t('common:shell.approvalWaiting')} detail={t('common:shell.approvals', { count: approvals })} />
                )}
                {runs > 0 && (
                  <NotifRow icon="feed-ticket" title={t('common:shell.runsTitle')} detail={t('common:shell.runs', { count: runs })} onSelect={() => navigate({ to: route.cowork })} />
                )}
                {recent.map((a) => (
                  <NotifRow key={a.id} icon={NOTIF_ICON[a.kind] ?? 'feed-star'} title={a.title} detail={a.detail} onSelect={() => navigate({ to: route.overview })} />
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Link
          to={route.settings.general}
          className={cn(iconBtn, 'group/set max-sm:hidden')}
          aria-label={t('common:settings')}
          title={t('common:settings')}
        >
          <span className="inline-flex transition-transform duration-500 ease-expo group-hover/set:rotate-90">
            <Icon name="hd-settings" />
          </span>
        </Link>
        {/* Phones: theme and settings share one overflow menu. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(iconBtn, 'sm:hidden pointer-coarse:size-10')}
              aria-label={t('common:more')}
              data-testid="header-more"
            >
              <Icon name="more" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => void setTheme(isDark ? 'light' : 'dark')}>
              <Icon name={isDark ? 'x-sun' : 'x-moon'} />
              <span>{isDark ? t('common:shell.lightMode') : t('common:shell.darkMode')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate({ to: route.settings.general })}>
              <Icon name="hd-settings" />
              <span>{t('common:settings')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
