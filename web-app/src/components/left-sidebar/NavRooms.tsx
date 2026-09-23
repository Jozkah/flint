import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuAction,
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
import { GroupedNav, type GroupRowProps } from '@/components/groups/GroupedNav'
import { MoveToGroupMenu } from '@/components/groups/MoveToGroupMenu'
import { ActiveDot } from '@/components/groups/ActiveDot'
import { folderBindingFor } from '@/lib/groups/folders'
import { ID_SEP, useActiveIdSet } from '@/lib/groups/useActiveIdSet'
import { useRoomsStore } from '@/lib/rooms/store'
import { getRoomPersistence } from '@/lib/rooms/persistence'
import { cn } from '@/lib/utils'

const roomId = (r: RoomSummary) => r.id
const roomLabel = (r: RoomSummary) => r.title

/**
 * A room's working folder, read-only: joining a group never changes it. The
 * open room is already in memory; otherwise the room file is read once, only
 * when the user moves the room into a group.
 */
async function roomFolders(r: RoomSummary) {
  const open = useRoomsStore.getState().room
  const folder =
    open?.id === r.id ? open.folder : (await getRoomPersistence().getRoom(r.id)).room.folder
  return folder ? [folderBindingFor(folder)] : []
}

const RoomItem = memo(function RoomItem({
  room,
  isCurrent,
  isMobile,
  onSelect,
  onRequestDelete,
  running,
  row,
}: {
  room: RoomSummary
  isCurrent: boolean
  isMobile: boolean
  onSelect: (id: string) => void
  onRequestDelete: (pending: { id: string; title: string }) => void
  running?: boolean
  /** Drag/keyboard wiring from the grouped sidebar. */
  row?: GroupRowProps
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
    <SidebarMenuItem
      {...row}
      className={cn('relative', row?.className)}
      onContextMenu={openRowMenu}
      onKeyDown={(e) => {
        row?.onKeyDown(e)
        if (!e.defaultPrevented) onRowKeyDown(e)
      }}
    >
      <SidebarMenuButton
        isActive={isCurrent}
        onClick={() => onSelect(room.id)}
        data-testid="room-item"
      >
        <span className="truncate">{room.title}</span>
        {running && <ActiveDot label="Room is running" className="ml-auto" />}
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
          <MoveToGroupMenu itemId={room.id} />
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
  const runningKey = useRoomsStore((s) => s.runningRoomIds.join(ID_SEP))
  const activeIds = useActiveIdSet(runningKey)

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

      <GroupedNav<RoomSummary>
        surface="rooms"
        items={summaries}
        getId={roomId}
        getLabel={roomLabel}
        activeIds={activeIds}
        selectedId={currentRoomId}
        ownFoldersOf={roomFolders}
        recentsLabel={t('common:recents')}
        renderItem={(room, row) => (
          <RoomItem
            key={room.id}
            room={room}
            isCurrent={room.id === currentRoomId}
            isMobile={isMobile}
            onSelect={selectRoom}
            onRequestDelete={setPendingDelete}
            running={activeIds.has(room.id)}
            row={row}
          />
        )}
      />

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
