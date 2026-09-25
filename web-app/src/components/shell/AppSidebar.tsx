import { useMemo } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  Activity,
  Box,
  ChevronsUpDown,
  Handshake,
  LayoutDashboard,
  Library,
  MessagesSquare,
  PanelLeft,
  Puzzle,
  ScrollText,
  Search,
  Server,
  Settings,
  SquarePen,
  Workflow,
  type LucideIcon,
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
  NavGroupLabel,
  NavItem,
  NavList,
  useShellNav,
} from '@/components/shell/nav-kit'
import { CoworkNav } from '@/components/shell/nav/CoworkNav'
import { RoomsNav } from '@/components/shell/nav/RoomsNav'
import { ChatsNav } from '@/components/shell/nav/ChatsNav'
import { FlintMark } from '@/components/shell/FlintMark'
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
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

type LinkRow = {
  to: string
  label: string
  icon: LucideIcon
  active: boolean
  count?: number
  testId?: string
}

function LinkRows({ rows, onNavigate }: { rows: LinkRow[]; onNavigate?: () => void }) {
  return (
    <>
      {rows.map((row) => {
        const Icon = row.icon
        return (
          <NavItem key={row.to}>
            <NavButton asChild isActive={row.active}>
              <Link
                to={row.to}
                data-testid={row.testId}
                aria-current={row.active ? 'page' : undefined}
                onClick={onNavigate}
              >
                <Icon aria-hidden />
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

/**
 * The app sidebar (250px): the Flint mark, search, and one scrolling list of
 * everything, grouped Workspace, Engine, Chats and Support, with local status
 * in the footer. On narrow windows the same sidebar is the navigation sheet.
 */
function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { toggle, isMobile } = useShellNav()
  const area = areaForPath(pathname)
  const leftButtons = useTitlebarLayout((s) => s.layout.left.length)
  const macOverlay = useMemo(() => detectMacOverlay(), [])
  const { reserveLeft } = resolveSidebarTitlebar(macOverlay, leftButtons)
  const providers = useModelProvider((s) => s.providers)
  const modelCount = useMemo(
    () =>
      providers
        .filter((p) => p.active)
        .reduce((n, p) => n + (p.models?.length ?? 0), 0),
    [providers]
  )

  const within = (base: string) =>
    pathname === base || pathname.startsWith(`${base}/`)

  const newChat = () => {
    useAgentMode.getState().removeThread(TEMPORARY_CHAT_ID)
    navigate({ to: route.home })
    onNavigate?.()
  }

  const engine: LinkRow[] = [
    {
      to: route.settings.model_providers,
      label: t('common:appRail.models'),
      icon: Box,
      active: area === 'models',
      count: modelCount,
      testId: 'rail-models',
    },
    {
      to: route.settings.mcp_servers,
      label: t('common:shell.toolsAndMcp'),
      icon: Workflow,
      active: area === 'tools',
      testId: 'rail-tools',
    },
    {
      to: route.extensions,
      label: t('common:appRail.extensions'),
      icon: Puzzle,
      active: area === 'extensions',
      testId: 'rail-extensions',
    },
    {
      to: route.systemMonitor,
      label: t('common:shell.systemMonitor'),
      icon: Activity,
      active: within(route.systemMonitor) || within(route.localApiServerlogs),
      testId: 'rail-system',
    },
  ]
  const support: LinkRow[] = [
    {
      to: route.appLogs,
      label: t('common:shell.logs'),
      icon: ScrollText,
      active: within(route.appLogs),
    },
    {
      to: route.settings.general,
      label: t('common:appRail.settings'),
      icon: Settings,
      active: area === 'settings',
      testId: 'cowork-settings',
    },
  ]

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div
        className={cn(
          'flex shrink-0 items-center justify-between px-3 py-3.5',
          reserveLeft && 'pl-20'
        )}
        data-tauri-drag-region
      >
        <Link
          to={route.overview}
          onClick={onNavigate}
          aria-label={t('common:appRail.home')}
          className="group/brand flex items-center gap-3 rounded-md text-foreground outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <FlintMark className="size-6 transition-transform duration-300 ease-expo group-hover/brand:-rotate-6 group-hover/brand:scale-105" />
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
            <PanelLeft />
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
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="flex-1 truncate text-[0.8125rem]">{t('common:shell.searchAnything')}</span>
          <span className="flex items-center gap-1 text-[11px] font-medium" aria-hidden>
            <PlatformMetaKey />
            <span>K</span>
          </span>
        </button>

        <nav
          aria-label={t('common:appRail.label')}
          data-testid="app-sidebar"
          className="-mx-3 flex min-h-0 flex-1 flex-col gap-5 overflow-x-hidden overflow-y-auto px-3 pb-2 [scrollbar-color:transparent_transparent] [scrollbar-width:thin] hover:[scrollbar-color:var(--border-strong)_transparent] [&::-webkit-scrollbar-thumb]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-border-strong"
        >
          <NavGroup>
            <NavGroupLabel>{t('common:appRail.workspace')}</NavGroupLabel>
            <NavList>
              <LinkRows
                onNavigate={onNavigate}
                rows={[
                  {
                    to: route.overview,
                    label: t('common:shell.overview'),
                    icon: LayoutDashboard,
                    active: pathname === route.overview,
                    testId: 'nav-overview',
                  },
                ]}
              />
              <NavItem>
                <NavButton
                  isActive={pathname === route.home}
                  onClick={newChat}
                  data-testid="nav-new-chat"
                >
                  <SquarePen aria-hidden />
                  <span className="flex-1 truncate">{t('common:newChat')}</span>
                  <span className="text-[10.5px] text-subtle-foreground [&_kbd]:shadow-none [&_kbd]:text-subtle-foreground">
                    <ShortcutHint action={ShortcutAction.NEW_CHAT} />
                  </span>
                </NavButton>
              </NavItem>
              <CoworkNav icon={Handshake} />
              <RoomsNav icon={MessagesSquare} />
              <LinkRows
                onNavigate={onNavigate}
                rows={[
                  {
                    to: route.artifacts,
                    label: t('common:appRail.library'),
                    icon: Library,
                    active: area === 'library',
                    testId: 'rail-library',
                  },
                ]}
              />
            </NavList>
          </NavGroup>

          <NavGroup>
            <NavGroupLabel>{t('common:shell.engine')}</NavGroupLabel>
            <NavList>
              <LinkRows rows={engine} onNavigate={onNavigate} />
            </NavList>
          </NavGroup>

          <ChatsNav />

          <NavGroup>
            <NavGroupLabel>{t('common:shell.support')}</NavGroupLabel>
            <NavList>
              <LinkRows rows={support} onNavigate={onNavigate} />
            </NavList>
          </NavGroup>
        </nav>

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
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
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
    <aside
      data-testid="app-sidebar-panel"
      data-state={open ? 'open' : 'closed'}
      className={cn(
        'relative flex h-full shrink-0 flex-col overflow-hidden bg-background transition-[width,opacity] duration-300 ease-expo',
        open ? 'w-(--sidebar-w) opacity-100' : 'w-0 opacity-0'
      )}
      inert={!open}
    >
      <div className="flex h-full w-(--sidebar-w) min-w-(--sidebar-w) flex-col">
        <SidebarBody />
      </div>
    </aside>
  )
}
