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
  MoreHorizontal,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import {
  MessageCircleIcon,
  type MessageCircleIconHandle,
} from '@/components/animated-icon/message-circle'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { usePrompt } from '@/hooks/usePrompt'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { memo, useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useFileActivity } from '@/hooks/useFileActivity'
import { FileActivityDialog } from '@/containers/dialogs/FileActivityDialog'
import SkillsManagerDialog from '@/containers/dialogs/SkillsManagerDialog'

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
  const activity = useFileActivity((s) => s.byConversation[session.id])

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
        title={session.title}
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
  // Session pending deletion; drives the confirm dialog (null = closed).
  const [pendingDelete, setPendingDelete] = useState<{
    id: string
    title: string
  } | null>(null)

  const goCowork = useCallback(() => navigate({ to: route.cowork }), [navigate])
  const newSessionIconRef = useRef<MessageCircleIconHandle>(null)
  const newSession = () => {
    // Idempotent: on a blank session this returns the same one, so a second
    // press cannot leave a trail of empty sessions behind. An unsent draft
    // keeps the user where they are rather than stranding it.
    const store = useCoworkSessions.getState()
    const id = store.startSession({
      running: Boolean(
        store.currentId && useCoworkRun.getState().liveTurns[store.currentId]?.length
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
  ]

  const confirmDelete = () => {
    if (pendingDelete) {
      useCoworkSessions.getState().deleteSession(pendingDelete.id)
      // The activity record is keyed by session; leaving it behind would keep
      // a deleted session's workflows in the store forever.
      useCoworkActivity.getState().dropSession(pendingDelete.id)
      // The file record is keyed by session too; leaving it behind would keep
      // a deleted session's paths in storage indefinitely.
      useFileActivity.getState().forget(pendingDelete.id)
    }
    setPendingDelete(null)
  }

  return (
    <>
      <SidebarMenu>
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
