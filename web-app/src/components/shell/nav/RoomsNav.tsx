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
  ChevronUp,
  DoorOpen,
  MessagesSquare,
  MoreHorizontal,
  Plus,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import {
  normalizeError,
  useRoomsApi,
  useRoomsState,
} from '@/containers/rooms/roomsBindings'
import type { RoomSummary } from '@/lib/rooms/types'
import { cn } from '@/lib/utils'
import { memo, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

const RoomItem = memo(function RoomItem({
  room,
  isCurrent,
  isMobile,
  onSelect,
  onRequestDelete,
}: {
  room: RoomSummary
  isCurrent: boolean
  isMobile: boolean
  onSelect: (id: string) => void
  onRequestDelete: (pending: { id: string; title: string }) => void
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)

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
        <span aria-hidden className="size-3.5 shrink-0" />
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
export function RoomsNav({ icon: Icon = MessagesSquare }: { icon?: LucideIcon }) {
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
          <Icon aria-hidden />
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
            <ChevronUp
              className={cn(
                'transition-transform duration-300 ease-expo',
                !expanded && 'rotate-180'
              )}
            />
          </button>
        </span>
      </NavItem>
      <NavCollapse open={expanded}>
        <NavList className="relative pt-0.5 pb-1 pl-5 before:absolute before:inset-y-1 before:left-[17px] before:w-px before:bg-border">
          <NavItem>
            <NavButton size="sub" onClick={() => navigate({ to: route.rooms })}>
              <Plus aria-hidden className="size-3.5" />
              <span>{t('common:shell.newRoom')}</span>
            </NavButton>
          </NavItem>
          {summaries.map((room) => (
            <RoomItem
              key={room.id}
              room={room}
              isCurrent={room.id === currentRoomId}
              isMobile={isMobile}
              onSelect={selectRoom}
              onRequestDelete={setPendingDelete}
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
