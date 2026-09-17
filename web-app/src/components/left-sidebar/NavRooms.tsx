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
import { useNavigate, useParams } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { MoreHorizontal, Plus, Trash2, DoorOpen } from 'lucide-react'
import {
  normalizeError,
  useRoomsApi,
  useRoomsState,
} from '@/containers/rooms/roomsBindings'
import type { RoomSummary } from '@/lib/rooms/types'
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
    <SidebarMenuItem onContextMenu={openRowMenu} onKeyDown={onRowKeyDown}>
      <SidebarMenuButton
        isActive={isCurrent}
        onClick={() => onSelect(room.id)}
      >
        <span className="truncate">{room.title}</span>
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
          <DropdownMenuItem onSelect={() => onSelect(room.id)}>
            <DoorOpen />
            <span>Open</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() =>
              onRequestDelete({ id: room.id, title: room.title })
            }
          >
            <Trash2 />
            <span>Delete</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
})

export function NavRooms() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { isMobile } = useSidebar()
  const api = useRoomsApi()
  const { summaries } = useRoomsState()
  const currentRoomId = useParams({
    strict: false,
    select: (params) => params.roomId,
  })
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
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={() => navigate({ to: route.rooms })}
          >
            <Plus className="text-ink-2" size={16} />
            <span>New Room</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>

      {summaries.length > 0 && (
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Rooms</SidebarGroupLabel>
          <SidebarMenu>
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
          </SidebarMenu>
        </SidebarGroup>
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete room</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{pendingDelete?.title}
              &rdquo;? This cannot be undone.
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
