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
import {
  NavAction,
  NavButton,
  NavCollapse,
  NavItem,
  NavList,
  useShellNav,
} from '@/components/shell/nav-kit'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  DoorOpen,
  MoreHorizontal,
  Plus,
  Trash2,
} from 'lucide-react'
import {
  normalizeError,
  useRoomsApi,
  useRoomsState,
} from '@/containers/rooms/roomsBindings'
import type { RoomSummary } from '@/lib/rooms/types'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/ui/icon'
import { memo, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ThreadStatusMark } from '@/containers/ThreadStatusMark'
import { useRoomsStore } from '@/lib/rooms/store'
import { roomNavStatus } from '@/lib/rooms/navStatus'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'

const RoomItem = memo(function RoomItem({
  room,
  isCurrent,
  isMobile,
  onSelect,
  onRequestDelete,
  running,
}: {
  room: RoomSummary
  isCurrent: boolean
  isMobile: boolean
  onSelect: (id: string) => void
  onRequestDelete: (pending: { id: string; title: string }) => void
  running?: boolean
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  // Waiting on the user: a pending tool approval for the room, or every
  // participant waiting on the user's reply or choice of speaker.
  const awaitingApproval = useToolApprovalRequests((s) =>
    Object.values(s.pending ?? {}).some((p) => p.threadId === room.id)
  )
  const status = roomNavStatus({
    status: room.status,
    running: !!running,
    awaitingApproval,
  })

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
    <NavItem onContextMenu={openRowMenu} onKeyDown={onRowKeyDown}>
      <NavButton
        size="sub"
        isActive={isCurrent}
        onClick={() => onSelect(room.id)}
        data-testid="room-nav-item"
      >
        <ThreadStatusMark status={status} />
        <span className="truncate">{room.title}</span>
      </NavButton>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <NavAction showOnHover>
            <MoreHorizontal />
            <span className="sr-only">{t('common:more')}</span>
          </NavAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-48"
          side={isMobile ? 'bottom' : 'right'}
          align={isMobile ? 'end' : 'start'}
        >
          <DropdownMenuItem onSelect={() => onSelect(room.id)}>
            <DoorOpen />
            <span>{t('common:open')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => onRequestDelete({ id: room.id, title: room.title })}
          >
            <Trash2 />
            <span>{t('common:delete')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </NavItem>
  )
})

/**
 * The Rooms row with its room tree. The row itself opens the rooms page (there
 * is no separate "All rooms" entry); the chevron shows or hides the rooms.
 */
export function RoomsNav({ icon }: { icon?: React.ReactNode }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { isMobile } = useShellNav()
  const api = useRoomsApi()
  const { summaries } = useRoomsState()
  const currentRoomId = useParams({
    strict: false,
    select: (params) => params.roomId,
  })
  const onRooms = pathname === route.rooms || pathname.startsWith(`${route.rooms}/`)
  const [treeOpen, setTreeOpen] = useState<boolean | null>(null)
  const expanded = treeOpen ?? onRooms
  const [pendingDelete, setPendingDelete] = useState<{
    id: string
    title: string
  } | null>(null)
  const runningRoomIds = useRoomsStore((s) => s.runningRoomIds)
  const visibleRooms = expanded
    ? summaries
    : summaries.filter((room) => runningRoomIds.includes(room.id))

  useEffect(() => {
    if (api.status !== 'ready') return
    api.loadSummaries().catch(() => {})
  }, [api])

  const selectRoom = useCallback(
    (id: string) => {
      navigate({ to: '/rooms/$roomId', params: { roomId: id } })
    },
    [navigate]
  )

  const confirmDelete = async () => {
    if (!pendingDelete) return
    try {
      await api.deleteRoom(pendingDelete.id)
      await api.loadSummaries()
      if (pendingDelete.id === currentRoomId) {
        navigate({ to: route.rooms })
      }
    } catch (err) {
      toast.error(normalizeError(err)?.message ?? 'Failed to delete room')
    }
    setPendingDelete(null)
  }

  return (
    <>
      <NavItem>
        <NavButton
          isActive={pathname === route.rooms}
          onClick={() => navigate({ to: route.rooms })}
          data-testid="nav-rooms"
        >
          {icon}
          <span className="flex-1 truncate">{t('common:appRail.rooms')}</span>
        </NavButton>
        <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1">
          <button
            type="button"
            aria-label={t('common:shell.showRooms')}
            aria-expanded={expanded}
            onClick={() => setTreeOpen(!expanded)}
            className="grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&>svg]:size-3"
          >
            <span
              className={cn(
                'inline-flex transition-transform duration-300 ease-expo',
                !expanded && 'rotate-180'
              )}
            >
              <Icon name="arrow-up" size={12} />
            </span>
          </button>
        </span>
      </NavItem>
      {/* Collapsed, the tree still lists the rooms that are running, until
          their run ends. */}
      <NavCollapse as="li" open={expanded || visibleRooms.length > 0}>
        <NavList className="relative pt-0.5 pb-1 pl-5 before:absolute before:inset-y-1 before:left-[17px] before:w-px before:bg-border">
          {expanded && (
            <NavItem>
              <NavButton
                size="sub"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onClick={() => navigate({ to: route.rooms, search: { new: 1 } as any })}
              >
                <Plus aria-hidden className="size-3.5" />
                <span>{t('common:shell.newRoom')}</span>
              </NavButton>
            </NavItem>
          )}
          {visibleRooms.map((room) => (
            <RoomItem
              key={room.id}
              room={room}
              isCurrent={room.id === currentRoomId}
              isMobile={isMobile}
              onSelect={selectRoom}
              onRequestDelete={setPendingDelete}
              running={runningRoomIds.includes(room.id)}
            />
          ))}
        </NavList>
      </NavCollapse>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common:shell.deleteRoomTitle')}</DialogTitle>
            <DialogDescription>
              {t('common:shell.deleteRoomBody', { title: pendingDelete?.title })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="surface" onClick={() => setPendingDelete(null)}>
              {t('common:cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              {t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
