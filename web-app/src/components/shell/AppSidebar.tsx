import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { useSidebarGlide } from '@/components/shell/useSidebarGlide'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  Activity,
  ChevronRight,
  Server,
  Settings,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import {
  NavButton,
  NavGroup,
  NavCollapse,
  NavGroupLabel,
  NavItem,
  NavList,
  useShellNav,
} from '@/components/shell/nav-kit'
import { CoworkNav } from '@/components/shell/nav/CoworkNav'
import { RoomsNav } from '@/components/shell/nav/RoomsNav'
import { ChatsNav } from '@/components/shell/nav/ChatsNav'
import { FlintMark } from '@/components/shell/FlintMark'
import { Icon, type IconName } from '@/components/ui/icon'
import { ShortcutHint } from '@/containers/ShortcutHint'
import { PlatformMetaKey } from '@/containers/PlatformMetaKey'
import { ShortcutAction } from '@/lib/shortcuts'
import { route } from '@/constants/routes'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { areaForPath } from '@/lib/shellNavigation'
import { detectMacOverlay, resolveSidebarTitlebar } from '@/lib/titlebar'
import { useTitlebarLayout } from '@/stores/titlebar-layout-store'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useHuggingFaceDownloads } from '@/hooks/useHuggingFaceDownloads'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sanitizeSidebarWidth,
  useInterfaceSettings,
} from '@/hooks/useInterfaceSettings'

type LinkRow = {
  to: string
  label: string
  icon: IconName
  active: boolean
  count?: number
  testId?: string
}

function LinkRows({ rows, onNavigate }: { rows: LinkRow[]; onNavigate?: () => void }) {
  return (
    <>
      {rows.map((row) => {
        return (
          <NavItem key={row.to}>
            <NavButton asChild isActive={row.active}>
              <Link
                to={row.to}
                data-testid={row.testId}
                aria-current={row.active ? 'page' : undefined}
                onClick={onNavigate}
              >
                <Icon name={row.icon} />
                <span className="flex-1 truncate">{row.label}</span>
                {row.count !== undefined && row.count > 0 && (
                  <span className="mr-1.5 text-[11px] text-muted-foreground tabular-nums">
                    {row.count}
                  </span>
                )}
              </Link>
            </NavButton>
          </NavItem>
        )
      })}
    </>
  )
}

const DISCLOSURE_KEY = 'flint:sidebar-disclosure'

function readDisclosure(id: string): boolean {
  try {
    return JSON.parse(localStorage.getItem(DISCLOSURE_KEY) ?? '{}')[id] === true
  } catch {
    return false
  }
}

function writeDisclosure(id: string, open: boolean) {
  try {
    const all = JSON.parse(localStorage.getItem(DISCLOSURE_KEY) ?? '{}')
    localStorage.setItem(DISCLOSURE_KEY, JSON.stringify({ ...all, [id]: open }))
  } catch {
    /* storage unavailable: the group simply starts closed */
  }
}

/**
 * A sidebar group that starts closed so the first screen is only what most
 * people came for. It opens itself when the current page lives inside it, and
 * remembers a manual open or close.
 */
function DisclosureGroup({
  id,
  label,
  containsActive,
  badge,
  testId,
  children,
}: {
  id: string
  label: string
  containsActive: boolean
  badge?: number
  testId: string
  children: React.ReactNode
}) {
  const [manual, setManual] = useState(() => readDisclosure(id))
  const open = manual || containsActive
  return (
    <NavGroup>
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        onClick={() => {
          const next = !open
          setManual(next)
          writeDisclosure(id, next)
        }}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-medium tracking-wide text-subtle-foreground uppercase outline-hidden hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <ChevronRight
          aria-hidden
          className={cn('size-3 transition-transform duration-200', open && 'rotate-90')}
        />
        <span className="flex-1 truncate">{label}</span>
        {!open && badge !== undefined && badge > 0 && (
          <span className="text-[11px] tabular-nums">{badge}</span>
        )}
      </button>
      <NavCollapse open={open}>
        <NavList>{children}</NavList>
      </NavCollapse>
    </NavGroup>
  )
}

/** Up and Down move between the sidebar's rows, Home and End to the ends. */
function moveFocusWithArrows(e: React.KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const target = e.target as HTMLElement
  if (target.closest('input, textarea, [role="menu"]')) return
  const rows = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[data-slot="nav-button"]')
  ).filter((el) => el.offsetParent !== null && !el.closest('[inert]'))
  const current = rows.findIndex((el) => el === target || el.contains(target))
  if (current === -1) return
  e.preventDefault()
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, current + (e.key === 'ArrowDown' ? 1 : -1)))
  rows[next]?.focus()
}

/**
 * The app sidebar (250px): the Flint mark, search, and one scrolling list of
 * the daily path (New chat, Cowork, Chats) up front and everything else
 * under More and Advanced, with local status
 * in the footer. On narrow windows the same sidebar is the navigation sheet.
 */
function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { toggle, isMobile } = useShellNav()
  const area = areaForPath(pathname)
  const navRef = useRef<HTMLElement>(null)
  useSidebarGlide(navRef)
  const leftButtons = useTitlebarLayout((s) => s.layout.left.length)
  const macOverlay = useMemo(() => detectMacOverlay(), [])
  const { leftPadClass } = resolveSidebarTitlebar(macOverlay, leftButtons)
  const providers = useModelProvider((s) => s.providers)
  const modelCount = useMemo(
    () =>
      providers
        .filter((p) => p.active)
        .reduce((n, p) => n + (p.models?.length ?? 0), 0),
    [providers]
  )

  const activeDownloads = useHuggingFaceDownloads(
    (s) =>
      Object.values(s.tasks).filter((task) =>
        ['queued', 'downloading', 'paused', 'verifying', 'importing'].includes(
          task.status
        )
      ).length
  )

  const within = (base: string) =>
    pathname === base || pathname.startsWith(`${base}/`)
  const inDiscover =
    pathname === route.hub.index.replace(/\/$/, '') || pathname.startsWith('/hub/')

  const newChat = () => {
    useAgentMode.getState().removeThread(TEMPORARY_CHAT_ID)
    navigate({ to: route.home })
    onNavigate?.()
  }

  const engine: LinkRow[] = [
    {
      to: route.hub.index,
      label: 'Discover',
      icon: 'search',
      active: inDiscover,
      count: activeDownloads,
      testId: 'rail-discover',
    },
    {
      to: route.settings.model_providers,
      label: t('common:appRail.models'),
      icon: 'x-cube',
      active: within(route.settings.model_providers),
      count: modelCount,
      testId: 'rail-models',
    },
    {
      to: route.settings.mcp_servers,
      label: t('common:shell.toolsAndMcp'),
      icon: 'flow',
      active: area === 'tools',
      testId: 'rail-tools',
    },
    {
      to: route.extensions,
      label: t('common:appRail.extensions'),
      icon: 'x-puzzle',
      active: area === 'extensions',
      testId: 'rail-extensions',
    },
    {
      to: route.systemMonitor,
      label: t('common:shell.systemMonitor'),
      icon: 'x-monitor',
      active: within(route.systemMonitor) || within(route.localApiServerlogs),
      testId: 'rail-system',
    },
  ]
  const more: LinkRow[] = [
    {
      to: route.artifacts,
      label: t('common:appRail.library'),
      icon: 'x-library',
      active: area === 'library',
      testId: 'rail-library',
    },
    {
      to: route.studio,
      label: 'Studio',
      icon: 'x-palette',
      active: pathname === route.studio,
      testId: 'nav-studio',
    },
  ]
  const moreActive = more.some((row) => row.active) || area === 'rooms'
  const advanced: LinkRow[] = [
    ...engine,
    {
      to: route.appLogs,
      label: t('common:shell.logs'),
      icon: 'x-terminal',
      active: within(route.appLogs),
    },
    {
      to: route.archive,
      label: t('archive:nav'),
      icon: 'x-disk',
      active: pathname === route.archive,
      testId: 'nav-archive',
    },
  ]
  const support: LinkRow[] = [
    {
      to: route.settings.general,
      label: t('common:appRail.settings'),
      icon: 'sb-settings',
      active: area === 'settings',
      testId: 'cowork-settings',
    },
  ]

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div
        className={cn(
          'flex shrink-0 items-center justify-between px-3 py-3.5',
          leftPadClass
        )}
        data-tauri-drag-region
      >
        <Link
          to={route.overview}
          onClick={onNavigate}
          aria-label={t('common:appRail.home')}
          className="group/brand flex items-center gap-3 rounded-md text-foreground outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <FlintMark className="size-[26px] drop-shadow-[0_1px_1px_rgba(0,0,0,.25)] transition-transform duration-500 ease-expo group-hover/brand:-rotate-12 group-hover/brand:scale-110 group-active/brand:rotate-[8deg] group-active/brand:scale-90 dark:brightness-125 dark:drop-shadow-[0_0_1px_rgba(255,255,255,.35)]" />
          <span className="text-base font-semibold tracking-[-0.01em]">Flint</span>
        </Link>
        {!isMobile && (
          <button
            type="button"
            onClick={toggle}
            aria-label={t('common:shell.collapseSidebar')}
            title={t('common:shell.collapseSidebar')}
            className="-m-1 grid cursor-pointer place-items-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&>svg]:size-4"
          >
            <Icon name="sidebar-right" />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-3 pb-4">
        <div aria-hidden className="h-px w-full shrink-0 bg-[linear-gradient(90deg,transparent,var(--border)_12%,var(--border)_88%,transparent)]" />
        <button
          type="button"
          data-testid="cowork-search"
          onClick={() => {
            useSearchDialog.getState().setOpen(true)
            onNavigate?.()
          }}
          className="flex h-8 w-full shrink-0 cursor-text items-center gap-2 overflow-clip rounded-lg border-[0.8px] border-border bg-card py-2 pr-2 pl-2.5 text-left text-muted-foreground shadow-[0_4px_14px_rgba(0,0,0,.04)] transition-[border-color,box-shadow] duration-150 outline-hidden hover:border-border-strong focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <Icon name="search" />
          <span className="flex-1 truncate text-[0.8125rem]">{t('common:shell.searchAnything')}</span>
          <span className="flex items-center gap-1 text-[11px] font-medium" aria-hidden>
            <PlatformMetaKey />
            <span>K</span>
          </span>
        </button>

        <nav
          ref={navRef}
          aria-label={t('common:appRail.label')}
          data-testid="app-sidebar"
          onKeyDown={moveFocusWithArrows}
          className="relative -mx-3 flex min-h-0 flex-1 flex-col gap-5 overflow-x-hidden overflow-y-auto px-3 pb-2 [scrollbar-color:transparent_transparent] [scrollbar-width:thin] hover:[scrollbar-color:var(--border-strong)_transparent] [&::-webkit-scrollbar-thumb]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-border-strong"
        >
          <NavGroup>
            <NavGroupLabel>{t('common:appRail.workspace')}</NavGroupLabel>
            <NavList>
              <NavItem>
                <NavButton
                  isActive={pathname === route.home}
                  onClick={newChat}
                  data-testid="nav-new-chat"
                >
                  <Icon name="x-edit" />
                  <span className="flex-1 truncate">{t('common:newChat')}</span>
                  <span className="text-[10.5px] text-subtle-foreground [&_kbd]:shadow-none [&_kbd]:text-subtle-foreground">
                    <ShortcutHint action={ShortcutAction.NEW_CHAT} />
                  </span>
                </NavButton>
              </NavItem>
              <CoworkNav icon={<Icon name="x-cowork" />} />
              <LinkRows
                onNavigate={onNavigate}
                rows={[
                  {
                    to: route.overview,
                    label: t('common:shell.resume'),
                    icon: 'sb-dashboard',
                    active: pathname === route.overview,
                    testId: 'nav-overview',
                  },
                ]}
              />
            </NavList>
          </NavGroup>

          <DisclosureGroup
            id="more"
            label={t('common:shell.more')}
            testId="nav-more"
            containsActive={moreActive}
          >
            <RoomsNav icon={<Icon name="x-rooms" />} />
            <LinkRows onNavigate={onNavigate} rows={more} />
          </DisclosureGroup>

          <DisclosureGroup
            id="advanced"
            label={t('common:shell.advanced')}
            testId="nav-advanced"
            containsActive={advanced.some((row) => row.active)}
            badge={activeDownloads}
          >
            <LinkRows rows={advanced} onNavigate={onNavigate} />
          </DisclosureGroup>

          <ChatsNav />
        </nav>

        <NavList>
          <LinkRows rows={support} onNavigate={onNavigate} />
        </NavList>

        <StatusCard onNavigate={onNavigate} />
      </div>
    </div>
  )
}

/** The footer card: what is running locally, one click from its settings. */
function StatusCard({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const loaded = useAppState((s) => s.activeModels.length)
  const serverStatus = useAppState((s) => s.serverStatus)
  const serverOn = serverStatus === 'running'
  const go = (to: string) => {
    navigate({ to })
    onNavigate?.()
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="shell-status"
          className="flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-xl border-[0.8px] border-border bg-card py-2 pr-2.5 pl-2 text-left drop-shadow-[0_0_4px_rgba(0,0,0,.03)] transition-[box-shadow,transform] duration-200 ease-expo outline-hidden hover:shadow-lift focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.98]"
        >
          <span className="relative grid size-8 shrink-0 place-items-center rounded-full border-[0.8px] border-av-border bg-av-bg">
            <FlintMark className="size-4" />
            <span className="absolute -right-0.5 -bottom-0.5 grid size-3 place-items-center rounded-full bg-card">
              <span className={cn('relative size-2 rounded-full', loaded > 0 ? 'bg-success' : 'bg-subtle-foreground')}>
                {loaded > 0 && (
                  <span className="absolute inset-0 rounded-full bg-success opacity-60 motion-safe:animate-ping" />
                )}
              </span>
            </span>
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <b className="truncate text-[0.8125rem] leading-none font-medium text-foreground">
              {t('common:shell.local')}
            </b>
            <small className="truncate text-[11px] leading-none text-muted-foreground">
              {t('common:statusBar.modelsLoaded', { count: loaded })}
            </small>
          </span>
          <Icon name="chevron-selector" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuLabel>{t('common:shell.thisComputer')}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => go(route.systemMonitor)}>
          <Activity />
          <span className="flex-1">{t('common:shell.systemMonitor')}</span>
          <span className="text-xs text-muted-foreground">
            {t('common:statusBar.modelsLoaded', { count: loaded })}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go(route.settings.local_api_server)}>
          <Server />
          <span className="flex-1">{t('common:shell.localApi')}</span>
          <span className={cn('text-xs', serverOn ? 'text-success' : 'text-muted-foreground')}>
            {serverOn ? t('common:shell.on') : t('common:shell.off')}
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => go(route.settings.general)}>
          <Settings />
          <span>{t('common:appRail.settings')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppSidebar() {
  const { t } = useTranslation()
  const { open, isMobile, openMobile, setOpenMobile } = useShellNav()

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          side="left"
          className="w-[250px] gap-0 p-0 sm:max-w-[250px] [&>button[data-slot=sheet-close]]:hidden"
          data-testid="navigation-sheet"
        >
          <SheetTitle className="sr-only">{t('common:appRail.label')}</SheetTitle>
          <SidebarBody onNavigate={() => setOpenMobile(false)} />
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <ResizableSidebar open={open}>
      <SidebarBody />
    </ResizableSidebar>
  )
}

/** How far one arrow-key press moves the sidebar's edge. */
const KEY_STEP = 16

/**
 * The docked sidebar, with a handle on its right edge that drags its width
 * between SIDEBAR_MIN_WIDTH and SIDEBAR_MAX_WIDTH. The width is kept only
 * when the drag ends, so a drag is not a stream of settings writes.
 * Double-clicking the handle puts the default width back.
 */
export function ResizableSidebar({
  open,
  children,
}: {
  open: boolean
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const savedWidth = useInterfaceSettings((s) => s.sidebarWidth)
  const setSidebarWidth = useInterfaceSettings((s) => s.setSidebarWidth)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const asideRef = useRef<HTMLElement>(null)
  const width = dragWidth ?? sanitizeSidebarWidth(savedWidth)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const aside = asideRef.current
    if (!aside) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    // The app can be zoomed: pointer positions are in screen pixels, the
    // width in CSS pixels, and the box's two sizes give the ratio between them.
    const rect = aside.getBoundingClientRect()
    const scale = aside.offsetWidth > 0 ? rect.width / aside.offsetWidth : 1
    const widthAt = (clientX: number) =>
      sanitizeSidebarWidth((clientX - rect.left) / (scale || 1))
    let latest = width
    const onMove = (ev: PointerEvent) => {
      latest = widthAt(ev.clientX)
      setDragWidth(latest)
    }
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
      setSidebarWidth(latest)
      setDragWidth(null)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setDragWidth(width)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === 'ArrowLeft'
        ? width - KEY_STEP
        : e.key === 'ArrowRight'
          ? width + KEY_STEP
          : e.key === 'Home'
            ? SIDEBAR_MIN_WIDTH
            : e.key === 'End'
              ? SIDEBAR_MAX_WIDTH
              : null
    if (next === null) return
    e.preventDefault()
    setSidebarWidth(next)
  }

  const resizing = dragWidth !== null

  return (
    <aside
      ref={asideRef}
      data-testid="app-sidebar-panel"
      data-state={open ? 'open' : 'closed'}
      data-resizing={resizing ? '' : undefined}
      style={{ '--sidebar-w': `${width}px` } as CSSProperties}
      className={cn(
        'relative flex h-full shrink-0 flex-col overflow-hidden bg-background',
        // Following the pointer, not easing after it.
        !resizing && 'transition-[width,opacity] duration-300 ease-expo',
        open ? 'w-(--sidebar-w) opacity-100' : 'w-0 opacity-0'
      )}
      inert={!open}
    >
      <div className="flex h-full w-(--sidebar-w) min-w-(--sidebar-w) flex-col">
        {children}
      </div>
      {open && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('common:appRail.resize')}
          aria-valuenow={width}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          tabIndex={0}
          data-testid="app-sidebar-resize"
          title={t('common:appRail.resizeHint')}
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
          className="group/resize absolute inset-y-0 right-0 z-20 flex w-2 cursor-col-resize touch-none justify-end outline-hidden"
        >
          <span
            aria-hidden
            className={cn(
              'h-full w-0.5 bg-transparent transition-colors duration-150 group-hover/resize:bg-border-strong group-focus-visible/resize:bg-ring',
              resizing && 'bg-ring'
            )}
          />
        </div>
      )}
    </aside>
  )
}
