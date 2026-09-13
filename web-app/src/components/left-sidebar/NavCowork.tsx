import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuAction,
  SidebarGroup,
  SidebarGroupLabel,
  useSidebar,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  Box,
  SlidersHorizontal,
  Copy,
  FileClock,
  GitFork,
  MoreHorizontal,
  Puzzle,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import {
  MessageCircleIcon,
  type MessageCircleIconHandle,
} from '@/components/animated-icon/message-circle'
import {
  SearchIcon,
  type SearchIconHandle,
} from '@/components/animated-icon/search'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { PlatformMetaKey } from '@/containers/PlatformMetaKey'
import { PlatformShortcuts, ShortcutAction } from '@/lib/shortcuts'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { usePrompt } from '@/hooks/usePrompt'
import { deleteCoworkSession } from '@/lib/coworkSessionLifecycle'
import { memo, useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useCoworkOrigins } from '@/hooks/useCoworkOrigins'
import { useFileActivity } from '@/hooks/useFileActivity'
import { FileActivityDialog } from '@/containers/dialogs/FileActivityDialog'
import SkillsManagerDialog from '@/containers/dialogs/SkillsManagerDialog'
import PluginsManagerDialog from '@/containers/dialogs/PluginsManagerDialog'

type CoworkNavItem = {
  title: string
  icon: LucideIcon
  onClick: () => void
}

// Own component (not inlined in a .map()) so it can be memoized: a change to
// one session re-renders its own row rather than the whole session list,
// mirroring ThreadList.tsx's memoized ThreadItem.
const SessionItem = memo(function SessionItem({
  session,
  isCurrent,
  isMobile,
  onSelect,
  onRequestDelete,
}: {
  session: CoworkSession
  isCurrent: boolean
  isMobile: boolean
  onSelect: (id: string) => void
  onRequestDelete: (pending: { id: string; title: string }) => void
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  // Subscribed, not read once: the ledger is written when a run ends, and a
  // snapshot taken at render time would leave the dialog describing the run
  // before last.
  const ledger = useCoworkOrigins((state) => state.bySession[session.id])
  const activity = useFileActivity((s) => s.byConversation[session.id])
  const running = useCoworkRun((s) => !!s.runs[session.id])

  /**
   * Open this row's own menu from right-click or the keyboard — the same
   * `DropdownMenu` the button opens, so the two cannot drift apart.
   */
  const openRowMenu = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuOpen(true)
  }

  const onRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      openRowMenu(e)
    }
  }

  return (
    <SidebarMenuItem onContextMenu={openRowMenu} onKeyDown={onRowKeyDown}>
      <SidebarMenuButton
        isActive={isCurrent}
        onClick={() => onSelect(session.id)}
      >
        <span className="truncate">{session.title}</span>
        {running && (
          // A session running in the background shows here, without the
          // session in view being treated as busy (janhq/jan#8905).
          <span
            role="status"
            aria-label={t('common:tasks.running', { count: 1 })}
            data-testid={`cowork-session-running-${session.id}`}
            className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
          />
        )}
      </SidebarMenuButton>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            showOnHover
            className="hover:bg-sidebar-foreground/8"
          >
            <MoreHorizontal />
            <span className="sr-only">More</span>
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-48"
          side={isMobile ? 'bottom' : 'right'}
          align={isMobile ? 'end' : 'start'}
        >
          <DropdownMenuItem onSelect={() => setActivityOpen(true)}>
            <FileClock />
            <span>{t('common:fileActivity.menuItem')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* AH-201. Copies the conversation and none of the access: the fork
              asks for its own folder and its own confirmation, so forking can
              never multiply authority that was granted once. */}
          <DropdownMenuItem
            data-testid="fork-session"
            onSelect={() => {
              const forked = useCoworkSessions.getState().forkSession(session.id)
              if (!forked) {
                toast.error(t('common:forkRefused'))
                return
              }
              toast.success(t('common:forkedSession'))
            }}
          >
            <GitFork />
            <span>{t('common:forkSession')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void navigator.clipboard?.writeText(session.id)
              toast.success(t('common:copiedConversationId'))
            }}
          >
            <Copy />
            <span>{t('common:copyConversationId')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() =>
              onRequestDelete({ id: session.id, title: session.title })
            }
          >
            <Trash2 />
            <span>{t('common:deleteSession')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <FileActivityDialog
        open={activityOpen}
        onOpenChange={setActivityOpen}
        events={activity ?? []}
        // The same ledger the Changes panel and the completion summary read,
        // so one file cannot be described three different ways.
        origins={ledger?.entries}
        title={session.title}
        // The rows were inert without these: the dialog disables a row it
        // cannot act on, so every row was disabled. Selecting the session
        // first means the request lands on the session it came from.
        onOpenFile={(path) => {
          setActivityOpen(false)
          onSelect(session.id)
          useCoworkRun.getState().requestCodeOpen(session.id, path, 'code')
        }}
        onOpenDiff={(path) => {
          setActivityOpen(false)
          onSelect(session.id)
          useCoworkRun.getState().requestCodeOpen(session.id, path, 'diff')
        }}
      />
    </SidebarMenuItem>
  )
})

export function NavCowork() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { isMobile } = useSidebar()
  const sessions = useCoworkSessions((s) => s.sessions)
  const currentId = useCoworkSessions((s) => s.currentId)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  // Session pending deletion; drives the confirm dialog (null = closed).
  const [pendingDelete, setPendingDelete] = useState<{
    id: string
    title: string
  } | null>(null)

  const goCowork = useCallback(() => navigate({ to: route.cowork }), [navigate])
  const newSessionIconRef = useRef<MessageCircleIconHandle>(null)
  const searchIconRef = useRef<SearchIconHandle>(null)
  const newSession = () => {
    // Idempotent: on a blank session this returns the same one, so a second
    // press cannot leave a trail of empty sessions behind. An unsent draft
    // keeps the user where they are rather than stranding it.
    const store = useCoworkSessions.getState()
    const id = store.startSession({
      running: Boolean(
        store.currentId && useCoworkRun.getState().runs[store.currentId]
      ),
      hasDraft: usePrompt.getState().prompt.trim().length > 0,
    })
    store.selectSession(id)
    goCowork()
  }
  const selectSession = useCallback(
    (id: string) => {
      useCoworkSessions.getState().selectSession(id)
      goCowork()
    },
    [goCowork]
  )

  const items: CoworkNavItem[] = [
    {
      title: t('common:artifacts'),
      icon: Box,
      onClick: () => navigate({ to: route.artifacts }),
    },
    {
      title: t('common:customize'),
      icon: SlidersHorizontal,
      onClick: () => setSkillsOpen(true),
    },
    {
      title: t('plugins:navLabel'),
      icon: Puzzle,
      onClick: () => setPluginsOpen(true),
    },
  ]

  const confirmDelete = () => {
    if (pendingDelete) {
      // Stops the session's run -- only that one -- and drops everything held
      // for it (janhq/jan#8905).
      deleteCoworkSession(pendingDelete.id)
    }
    setPendingDelete(null)
  }

  return (
    <>
      <SidebarMenu>
        {/* Cowork replaces `NavMain` in the sidebar, so it has to carry the
            same entries NavMain does; without this, Search and Settings were
            simply absent on this tab. Same dialog, same route -- opened
            through the shared store, not a second implementation. */}
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={() => useSearchDialog.getState().setOpen(true)}
            data-testid="cowork-search"
            onMouseEnter={() => searchIconRef.current?.startAnimation()}
            onMouseLeave={() => searchIconRef.current?.stopAnimation()}
          >
            <SearchIcon
              ref={searchIconRef}
              className="text-foreground/70"
              size={16}
            />
            <span>{t('common:search')}</span>
            <KbdGroup className="ml-auto scale-90 gap-0">
              <Kbd className="bg-transparent size-3">
                <PlatformMetaKey />
              </Kbd>
              <Kbd className="bg-transparent size-3 uppercase">
                {PlatformShortcuts[ShortcutAction.SEARCH].key}
              </Kbd>
            </KbdGroup>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={newSession}
            onMouseEnter={() => newSessionIconRef.current?.startAnimation()}
            onMouseLeave={() => newSessionIconRef.current?.stopAnimation()}
          >
            <MessageCircleIcon
              ref={newSessionIconRef}
              className="text-foreground/70"
              size={16}
            />
            <span>{t('common:newSession')}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {items.map((item) => {
          const Icon = item.icon
          return (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton onClick={item.onClick}>
                <Icon className="text-foreground/70" size={16} />
                <span>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>

      {sessions.length > 0 && (
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>{t('common:sessions')}</SidebarGroupLabel>
          <SidebarMenu>
            {sessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isCurrent={session.id === currentId}
                isMobile={isMobile}
                onSelect={selectSession}
                onRequestDelete={setPendingDelete}
              />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      )}

      <SkillsManagerDialog open={skillsOpen} onOpenChange={setSkillsOpen} />
      <PluginsManagerDialog open={pluginsOpen} onOpenChange={setPluginsOpen} />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common:deleteSessionTitle')}</DialogTitle>
            <DialogDescription>
              {t('common:deleteSessionBody', { title: pendingDelete?.title })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingDelete(null)}
            >
              {t('common:cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmDelete}>
              {t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
