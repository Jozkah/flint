import { FadeText } from '@/components/ui/fade-text'
import { RowPreview } from '@/components/shell/nav/RowPreview'
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
import { Columns2, DoorOpen, MoreHorizontal, Plus, Sparkles, Trash2 } from 'lucide-react'
import { regenerateRoomTitle } from '@/lib/regenerateSessionTitle'
import { regenerateWithToast } from '@/lib/regenerateToast'
import {
  normalizeError,
  useRoomsApi,
  useRoomsState,
} from '@/containers/rooms/roomsBindings'
import type { RoomSummary } from '@/lib/rooms/types'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/ui/icon'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ThreadStatusMark } from '@/containers/ThreadStatusMark'
import { useRoomsStore } from '@/lib/rooms/store'
import { openInSplit, reportSplitResult } from '@/lib/splitView'
import { roomNavStatus } from '@/lib/rooms/navStatus'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { GroupedTree, MoveToGroupSub } from '@/components/shell/nav/GroupedTree'
import { roomFolderAdapter } from '@/lib/groups/adapters'
import type { FolderAdapter } from '@/lib/groups/inherit'

const RoomItem = memo(function RoomItem({
  room,
  isCurrent,
  isMobile,
  onSelect,
  onRequestDelete,
  running,
  adapter,
}: {
  room: RoomSummary
  adapter: FolderAdapter
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
      <RowPreview
        title={room.title}
        updated={room.updatedAt}
        summary={room.objective}
        suppressed={menuOpen}
      >
        <NavButton
          size="sub"
          isActive={isCurrent}
          onClick={() => onSelect(room.id)}
          data-testid="room-nav-item"
        >
          <ThreadStatusMark status={status} />
          <FadeText>{room.title}</FadeText>
        </NavButton>
      </RowPreview>
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
          <DropdownMenuItem
            data-testid="regenerate-room-title"
            onSelect={() =>
              regenerateWithToast(() => regenerateRoomTitle(room.id), t)
            }
          >
            <Sparkles />
            <span>{t('chat:regenerateTitle.menu')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onSelect(room.id)}>
            <DoorOpen />
            <span>{t('common:open')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="open-room-in-split"
            onSelect={() =>
              reportSplitResult(
                openInSplit({ kind: 'room', refId: room.id }),
                t
              )
            }
          >
            <Columns2 />
            <span>{t('chat:split.openInSplit')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <MoveToGroupSub surface="rooms" itemId={room.id} adapter={adapter} />
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
  const onRooms =
    pathname === route.rooms || pathname.startsWith(`${route.rooms}/`)
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

  const adapter = useMemo(() => roomFolderAdapter(api), [api])
  const newRoom = (groupId?: string) => {
    // The create dialog puts the new room in the group itself.
    navigate({
      to: route.rooms,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      search: (groupId ? { new: 1, group: groupId } : { new: 1 }) as any,
    })
  }
  const roomIds = useMemo(() => summaries.map((r) => r.id), [summaries])
  const byId = useMemo(
    () => new Map(summaries.map((r) => [r.id, r])),
    [summaries]
  )
  const renderRoom = (id: string) => {
    const room = byId.get(id)
    if (!room) return null
    return (
      <RoomItem
        key={room.id}
        room={room}
        isCurrent={room.id === currentRoomId}
        isMobile={isMobile}
        onSelect={selectRoom}
        onRequestDelete={setPendingDelete}
        running={runningRoomIds.includes(room.id)}
        adapter={adapter}
      />
    )
  }

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
              <NavButton size="sub" onClick={() => newRoom()}>
                <Plus aria-hidden className="size-3.5" />
                <span>{t('common:shell.newRoom')}</span>
              </NavButton>
            </NavItem>
          )}
          {expanded ? (
            <GroupedTree
              surface="rooms"
              ids={roomIds}
              renderItem={renderRoom}
              keepVisible={(id) =>
                id === currentRoomId || runningRoomIds.includes(id)
              }
              adapter={adapter}
              onNewInGroup={newRoom}
              newInLabelKey="common:groups.newRoomIn"
              showNewGroup
            />
          ) : (
            visibleRooms.map((room) => renderRoom(room.id))
          )}
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
              {t('common:shell.deleteRoomBody', {
                title: pendingDelete?.title,
              })}
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
