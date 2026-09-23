/**
 * The one grouped sidebar list used by Home, Cowork and Rooms. A surface
 * passes its items (in its own recent-activity order), which ids are active,
 * and how to render a row; this component owns groups, Recents, drag and drop,
 * keyboard movement, compact mode and announcements.
 *
 * Each surface mounts its own DndContext, so an item can never be dropped onto
 * another surface's list; the store also refuses cross-surface moves.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import {
  ChevronRight,
  FolderIcon,
  FolderOpen,
  FolderCog,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  ChevronsDownUp,
  ChevronsUpDown,
  Rows2,
  Rows3,
} from 'lucide-react'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, useSidebar } from '@/components/ui/sidebar'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { cn } from '@/lib/utils'
import { layoutSurface } from '@/lib/groups/domain'
import { useConversationGroups } from '@/lib/groups/store'
import { announce } from '@/lib/groups/announce'
import type { ConversationGroup, GroupFolderBinding, GroupSurface } from '@/lib/groups/types'
import { needsResolution, planResolution, type FolderChoice } from '@/lib/groups/resolution'
import { FolderResolutionDialog, type FolderResolutionRequest } from './FolderResolutionDialog'
import { GroupedNavContext, type GroupedNavApi } from './context'
import { GroupFoldersDialog } from './GroupFoldersDialog'
import { ActiveDot } from './ActiveDot'

/** Props a surface spreads onto its row's `SidebarMenuItem`. */
export type GroupRowProps = {
  ref: (el: HTMLElement | null) => void
  style?: CSSProperties
  'data-group-item': string
  'data-dragging'?: boolean
  onKeyDown: (e: ReactKeyboardEvent) => void
  onPointerDown?: (e: React.PointerEvent) => void
  className?: string
}

export type GroupedNavProps<T> = {
  surface: GroupSurface
  /** All items, in the surface's recent-activity order. */
  items: readonly T[]
  getId: (item: T) => string
  getLabel: (item: T) => string
  activeIds: ReadonlySet<string>
  selectedId?: string | null
  renderItem: (item: T, row: GroupRowProps) => ReactNode
  recentsLabel: string
  recentsAction?: ReactNode
  /** Shown instead of the Recents list when it is empty. */
  emptyRecents?: ReactNode
  /**
   * The folders an item already works in (its attached folder). Used to
   * decide whether joining a group needs folder resolution. Read-only.
   */
  ownFoldersOf?: (item: T) => GroupFolderBinding[] | Promise<GroupFolderBinding[]>
  compact?: boolean
  className?: string
}

const AUTO_EXPAND_MS = 600
const GROUP_PREFIX = 'grp:'
const ITEM_PREFIX = 'item:'
const RECENTS_DROP = 'drop:recents'
const groupDropId = (id: string) => `drop:${id}`

function stripPrefix(id: string, prefix: string) {
  return id.startsWith(prefix) ? id.slice(prefix.length) : null
}

export function GroupedNav<T>(props: GroupedNavProps<T>) {
  const {
    surface,
    items,
    getId,
    getLabel,
    activeIds,
    selectedId,
    renderItem,
    recentsLabel,
    recentsAction,
    emptyRecents,
    ownFoldersOf,
    className,
  } = props
  const { isMobile } = useSidebar()
  const storedCompact = useLeftPanel((s) => s.groupsCompact)
  const setCompact = useLeftPanel((s) => s.setGroupsCompact)
  const compact = props.compact ?? storedCompact
  const surfaceState = useConversationGroups((s) => s.state.surfaces[surface])
  const loaded = useConversationGroups((s) => s.loaded[surface])
  const revealed = useConversationGroups((s) => s.revealed[surface])
  const store = useConversationGroups.getState

  const layout = useMemo(() => layoutSurface(surfaceState, items, getId), [surfaceState, items, getId])
  const itemById = useMemo(() => {
    const m = new Map<string, T>()
    for (const i of items) m.set(getId(i), i)
    return m
  }, [items, getId])

  // Drop memberships of items that were deleted elsewhere.
  useEffect(() => {
    if (!loaded || items.length === 0) return
    void store().pruneMissing(surface, new Set(items.map(getId)))
  }, [loaded, items, getId, surface, store])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ConversationGroup | null>(null)
  const [foldersFor, setFoldersFor] = useState<ConversationGroup | null>(null)
  /** Groups opened just for this view (compact peek, navigation reveal). */
  const [peeked, setPeeked] = useState<ReadonlySet<string>>(new Set())
  const pendingItemForNewGroup = useRef<string | null>(null)

  // Reveal the selected item's group for this navigation without persisting.
  useEffect(() => {
    if (!revealed) return
    const gid = surfaceState.memberships[revealed]?.groupId
    if (gid) setPeeked((p) => new Set(p).add(gid))
  }, [revealed, surfaceState.memberships])

  const groupIdOf = useCallback(
    (itemId: string) => {
      const gid = surfaceState.memberships[itemId]?.groupId
      return gid && surfaceState.groups.some((g) => g.id === gid) ? gid : null
    },
    [surfaceState]
  )

  const [resolution, setResolution] = useState<
    (FolderResolutionRequest & { resolve: (c: FolderChoice) => void }) | null
  >(null)
  const askResolution = useCallback(
    (req: FolderResolutionRequest) =>
      new Promise<FolderChoice>((resolve) => setResolution({ ...req, resolve })),
    []
  )

  const requestMove = useCallback(
    async (itemId: string, groupId: string | null, toIndex?: number) => {
      const item = itemById.get(itemId)
      if (!item) return false
      const current = groupIdOf(itemId)
      const target = groupId ? surfaceState.groups.find((g) => g.id === groupId) ?? null : null
      if (groupId && !target) {
        announce('That group is not available here')
        return false
      }
      // Reordering inside the same group, or leaving for Recents, keeps the
      // item's folder context and grants exactly as they are.
      if (!target || current === groupId) {
        return store().moveItem(surface, itemId, groupId, toIndex)
      }
      let own: GroupFolderBinding[] = []
      try {
        own = (await ownFoldersOf?.(item)) ?? []
      } catch {
        own = []
      }
      const itemState = { own, context: surfaceState.contexts[itemId] }
      if (!needsResolution(itemState, target)) {
        return store().moveItem(surface, itemId, groupId, toIndex)
      }
      const choice = await askResolution({ itemLabel: getLabel(item), item: itemState, group: target })
      const plan = planResolution(choice, itemState, target, Date.now())
      if (plan.cancelled) {
        announce('Move cancelled. Membership and permissions unchanged')
        return false
      }
      return store().moveWithPlan(surface, itemId, groupId, toIndex, plan)
    },
    [itemById, groupIdOf, surfaceState, ownFoldersOf, askResolution, getLabel, store, surface]
  )

  const startNewGroup = useCallback(
    async (withItem?: string) => {
      const id = await store().createGroup(surface, 'New group')
      if (!id) return
      pendingItemForNewGroup.current = withItem ?? null
      setEditingId(id)
    },
    [store, surface]
  )

  const finishRename = useCallback(
    async (group: ConversationGroup, name: string | null) => {
      setEditingId(null)
      if (name !== null && name.trim() && name.trim() !== group.name) {
        await store().renameGroup(surface, group.id, name)
      }
      const itemId = pendingItemForNewGroup.current
      pendingItemForNewGroup.current = null
      if (itemId) await requestMove(itemId, group.id)
    },
    [store, surface, requestMove]
  )

  const api: GroupedNavApi = useMemo(
    () => ({
      surface,
      groups: layout.groups.map((g) => g.group),
      groupIdOf,
      requestMove,
      createGroupWith: (itemId) => void startNewGroup(itemId),
    }),
    [surface, layout.groups, groupIdOf, requestMove, startNewGroup]
  )

  // ---- drag and drop -------------------------------------------------------
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } })
  )
  const [activeDrag, setActiveDrag] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearExpandTimer = () => {
    if (expandTimer.current) clearTimeout(expandTimer.current)
    expandTimer.current = null
  }

  const onDragStart = (e: DragStartEvent) => {
    setActiveDrag(String(e.active.id))
  }

  const targetGroupOfOver = (over: string): string | null | undefined => {
    const g = stripPrefix(over, GROUP_PREFIX) ?? stripPrefix(over, 'drop:')
    if (g === 'recents') return null
    if (g) return g
    const itemId = stripPrefix(over, ITEM_PREFIX)
    if (itemId) return groupIdOf(itemId)
    return undefined
  }

  const onDragOver = (e: DragOverEvent) => {
    const over = e.over ? String(e.over.id) : null
    setOverId(over)
    clearExpandTimer()
    if (!over || !activeDrag?.startsWith(ITEM_PREFIX)) return
    const gid = stripPrefix(over, GROUP_PREFIX) ?? stripPrefix(over, 'drop:')
    const group = gid ? surfaceState.groups.find((g) => g.id === gid) : undefined
    if (group?.collapsed) {
      expandTimer.current = setTimeout(() => {
        void store().setCollapsed(surface, group.id, false)
      }, AUTO_EXPAND_MS)
    }
  }

  const onDragEnd = async (e: DragEndEvent) => {
    clearExpandTimer()
    setActiveDrag(null)
    setOverId(null)
    const active = String(e.active.id)
    const over = e.over ? String(e.over.id) : null
    if (!over || over === active) return

    const draggedGroup = stripPrefix(active, GROUP_PREFIX)
    if (draggedGroup) {
      const target = targetGroupOfOver(over)
      if (!target) return
      const toIndex = layout.groups.findIndex((g) => g.group.id === target)
      if (toIndex >= 0) await store().reorderGroup(surface, draggedGroup, toIndex)
      return
    }

    const itemId = stripPrefix(active, ITEM_PREFIX)
    if (!itemId) return
    const target = targetGroupOfOver(over)
    if (target === undefined) return
    let toIndex: number | undefined
    const overItem = stripPrefix(over, ITEM_PREFIX)
    if (target && overItem) {
      const children = layout.groups.find((g) => g.group.id === target)?.children ?? []
      toIndex = children.findIndex((c) => getId(c) === overItem)
      // moveItem removes then inserts, which matches arrayMove(from, over).
    }
    if (target === groupIdOf(itemId) && toIndex === undefined) return
    await requestMove(itemId, target, toIndex)
  }

  const onDragCancel = () => {
    clearExpandTimer()
    setActiveDrag(null)
    setOverId(null)
  }

  const draggingItem = activeDrag?.startsWith(ITEM_PREFIX)
  const insertionTarget = draggingItem ? overId : null

  // ---- keyboard ------------------------------------------------------------
  const moveItemByKey = async (itemId: string, delta: number) => {
    const gid = groupIdOf(itemId)
    if (!gid) {
      announce('Recents follow recent activity. Use the menu to move this item into a group')
      return
    }
    const children = layout.groups.find((g) => g.group.id === gid)?.children ?? []
    const from = children.findIndex((c) => getId(c) === itemId)
    const to = from + delta
    if (to < 0 || to >= children.length) return
    await store().moveItem(surface, itemId, gid, to)
  }

  const rowPropsFor = (itemId: string, sortable: ReturnType<typeof useSortable> | null): GroupRowProps => ({
    ref: sortable ? sortable.setNodeRef : () => {},
    style: sortable?.transform
      ? { transform: `translate3d(0, ${Math.round(sortable.transform.y)}px, 0)`, transition: sortable.transition }
      : undefined,
    'data-group-item': itemId,
    'data-dragging': sortable?.isDragging || undefined,
    onPointerDown: sortable?.listeners?.onPointerDown as GroupRowProps['onPointerDown'],
    onKeyDown: (e) => {
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        void moveItemByKey(itemId, e.key === 'ArrowUp' ? -1 : 1)
      }
    },
    className: cn(
      sortable?.isDragging && 'opacity-40',
      insertionTarget === `${ITEM_PREFIX}${itemId}` &&
        'before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded-full before:bg-brand before:content-[""]'
    ),
  })

  const renderRow = (item: T, sortableEnabled: boolean) => {
    const id = getId(item)
    return (
      <SortableRow key={id} id={id} enabled={sortableEnabled}>
        {(sortable) => renderItem(item, rowPropsFor(id, sortable))}
      </SortableRow>
    )
  }

  const groupIds = layout.groups.map((g) => `${GROUP_PREFIX}${g.group.id}`)

  return (
    <GroupedNavContext.Provider value={api}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={(e) => void onDragEnd(e)}
        onDragCancel={onDragCancel}
        accessibility={{
          announcements: {
            onDragStart: () => 'Picked up. Drop on a group or on Recents.',
            onDragOver: () => undefined,
            onDragEnd: () => undefined,
            onDragCancel: () => 'Move cancelled',
          },
        }}
      >
        <SidebarGroup className={cn('group-data-[collapsible=icon]:hidden', className)} data-testid={`groups-${surface}`}>
          <div className="flex items-center gap-0.5 pr-1">
            <SidebarGroupLabel className="flex-1">Groups</SidebarGroupLabel>
            <button
              type="button"
              onClick={() => setCompact(!compact)}
              aria-pressed={compact}
              title={compact ? 'Show group contents' : 'Compact groups'}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sunken pointer-coarse:size-11"
              data-testid={`groups-${surface}-compact`}
            >
              {compact ? <Rows3 className="size-3.5" /> : <Rows2 className="size-3.5" />}
              <span className="sr-only">Compact groups view</span>
            </button>
            <button
              type="button"
              onClick={() => void startNewGroup()}
              title="New group"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sunken pointer-coarse:size-11"
              data-testid={`groups-${surface}-new`}
            >
              <Plus className="size-4" />
              <span className="sr-only">New group</span>
            </button>
          </div>
          <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
            <ul aria-label={`${surfaceTitle(surface)} groups`} className="flex flex-col gap-0.5">
              {layout.groups.map(({ group, children }) => {
                const open = compact ? peeked.has(group.id) : !group.collapsed || peeked.has(group.id)
                const activeCount = children.filter((c) => activeIds.has(getId(c))).length
                return (
                  <GroupRow
                    key={group.id}
                    group={group}
                    surface={surface}
                    count={children.length}
                    activeCount={activeCount}
                    open={open}
                    compact={compact}
                    isMobile={isMobile}
                    editing={editingId === group.id}
                    dropHighlight={
                      !!draggingItem &&
                      (overId === `${GROUP_PREFIX}${group.id}` || overId === groupDropId(group.id))
                    }
                    containsSelection={!!selectedId && children.some((c) => getId(c) === selectedId)}
                    onToggle={() => {
                      if (compact || (peeked.has(group.id) && group.collapsed)) {
                        setPeeked((p) => {
                          const n = new Set(p)
                          if (n.has(group.id)) n.delete(group.id)
                          else n.add(group.id)
                          return n
                        })
                        return
                      }
                      void store().setCollapsed(surface, group.id, !group.collapsed)
                    }}
                    onRename={() => setEditingId(group.id)}
                    onRenameDone={(name) => void finishRename(group, name)}
                    onManageFolders={() => setFoldersFor(group)}
                    onDelete={() => {
                      if (children.length === 0) void store().deleteGroup(surface, group.id)
                      else setPendingDelete(group)
                    }}
                    onMoveBy={(delta) => {
                      const to = group.position + delta
                      if (to >= 0 && to < layout.groups.length) void store().reorderGroup(surface, group.id, to)
                    }}
                  >
                    {open && (
                      <GroupChildren
                        groupId={group.id}
                        ids={children.map((c) => `${ITEM_PREFIX}${getId(c)}`)}
                        empty={children.length === 0}
                      >
                        {children.map((c) => renderRow(c, true))}
                      </GroupChildren>
                    )}
                  </GroupRow>
                )
              })}
            </ul>
          </SortableContext>
        </SidebarGroup>

        <RecentsSection
          label={recentsLabel}
          action={recentsAction}
          highlight={!!draggingItem && overId === RECENTS_DROP}
          ids={layout.recents.map((r) => `${ITEM_PREFIX}${getId(r)}`)}
          surface={surface}
        >
          {layout.recents.length === 0 && emptyRecents}
          {layout.recents.map((r) => renderRow(r, true))}
        </RecentsSection>

        <DragOverlay dropAnimation={null}>
          {activeDrag ? (
            <div className="rounded-md bg-surface px-3 py-1.5 text-sm shadow-lg ring-1 ring-border">
              {stripPrefix(activeDrag, GROUP_PREFIX)
                ? surfaceState.groups.find((g) => g.id === stripPrefix(activeDrag, GROUP_PREFIX))?.name
                : (() => {
                    const it = itemById.get(stripPrefix(activeDrag, ITEM_PREFIX) ?? '')
                    return it ? getLabel(it) : null
                  })()}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <Dialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete group “{pendingDelete?.name}”?</DialogTitle>
            <DialogDescription>
              Its items move to Recents. No conversation, session or room is deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="confirm-delete-group"
              onClick={() => {
                const g = pendingDelete
                setPendingDelete(null)
                if (g) void store().deleteGroup(surface, g.id)
              }}
            >
              Delete group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FolderResolutionDialog
        request={resolution}
        onChoose={(c) => {
          const r = resolution
          setResolution(null)
          r?.resolve(c)
        }}
      />

      {foldersFor && (
        <GroupFoldersDialog
          surface={surface}
          group={surfaceState.groups.find((g) => g.id === foldersFor.id) ?? foldersFor}
          open
          onOpenChange={(o) => !o && setFoldersFor(null)}
        />
      )}
    </GroupedNavContext.Provider>
  )
}

function surfaceTitle(s: GroupSurface) {
  return s === 'home' ? 'Home' : s === 'cowork' ? 'Cowork' : 'Rooms'
}

function SortableRow({
  id,
  enabled,
  children,
}: {
  id: string
  enabled: boolean
  children: (s: ReturnType<typeof useSortable> | null) => ReactNode
}) {
  const sortable = useSortable({ id: `${ITEM_PREFIX}${id}`, disabled: !enabled })
  return <>{children(sortable)}</>
}

function GroupChildren({
  groupId,
  ids,
  empty,
  children,
}: {
  groupId: string
  ids: string[]
  empty: boolean
  children: ReactNode
}) {
  const { setNodeRef } = useDroppable({ id: groupDropId(groupId) })
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <SidebarMenu ref={setNodeRef} id={`group-children-${groupId}`} className="ml-3 border-l border-border/60 pl-1">
        {empty && (
          <li className="px-3 py-1.5 text-xs text-muted-foreground">Drag items here or use Move to group</li>
        )}
        {children}
      </SidebarMenu>
    </SortableContext>
  )
}

function RecentsSection({
  label,
  action,
  highlight,
  ids,
  surface,
  children,
}: {
  label: string
  action?: ReactNode
  highlight: boolean
  ids: string[]
  surface: GroupSurface
  children: ReactNode
}) {
  const { setNodeRef } = useDroppable({ id: RECENTS_DROP })
  return (
    <SidebarGroup
      ref={setNodeRef}
      className={cn('group-data-[collapsible=icon]:hidden rounded-md', highlight && 'ring-2 ring-brand/60')}
      data-testid={`recents-${surface}`}
    >
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      {action}
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <SidebarMenu aria-label={label}>{children}</SidebarMenu>
      </SortableContext>
    </SidebarGroup>
  )
}

type GroupRowViewProps = {
  group: ConversationGroup
  surface: GroupSurface
  count: number
  activeCount: number
  open: boolean
  compact: boolean
  isMobile: boolean
  editing: boolean
  dropHighlight: boolean
  containsSelection: boolean
  onToggle: () => void
  onRename: () => void
  onRenameDone: (name: string | null) => void
  onManageFolders: () => void
  onDelete: () => void
  onMoveBy: (delta: number) => void
  children?: ReactNode
}

const GroupRow = memo(function GroupRow(p: GroupRowViewProps) {
  const { group } = p
  const sortable = useSortable({ id: `${GROUP_PREFIX}${group.id}`, disabled: p.editing })
  const [menuOpen, setMenuOpen] = useState(false)
  const unavailable = group.folderBindings.filter((b) => b.available === false).length
  const active = p.activeCount > 0
  const statusText = [
    `${p.count} ${p.count === 1 ? 'item' : 'items'}`,
    active ? `${p.activeCount} active` : null,
    p.open ? 'expanded' : 'collapsed',
  ]
    .filter(Boolean)
    .join(', ')

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (p.editing) return
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      p.onMoveBy(e.key === 'ArrowUp' ? -1 : 1)
    } else if (e.key === 'F2') {
      e.preventDefault()
      p.onRename()
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      setMenuOpen(true)
    } else if (e.key === 'ArrowRight' && !p.open) {
      e.preventDefault()
      p.onToggle()
    } else if (e.key === 'ArrowLeft' && p.open) {
      e.preventDefault()
      p.onToggle()
    }
  }

  const header = (
    <div
      className={cn(
        'group/grp relative flex items-center gap-1.5 rounded-md pr-8 text-sm hover:bg-accent pointer-coarse:min-h-11',
        p.dropHighlight && 'bg-accent ring-2 ring-brand/60',
        p.containsSelection && !p.open && 'bg-accent/60'
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11"
        aria-expanded={p.open}
        aria-controls={`group-children-${group.id}`}
        aria-label={`${group.name}, ${statusText}`}
        data-testid={`group-row-${group.id}`}
        onClick={p.onToggle}
        onKeyDown={onKeyDown}
        onDoubleClick={p.onRename}
        {...(p.editing ? {} : { onPointerDown: sortable.listeners?.onPointerDown as never })}
      >
        {!p.compact && (
          <ChevronRight
            aria-hidden
            className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', p.open && 'rotate-90')}
          />
        )}
        {p.open ? (
          <FolderOpen aria-hidden className="size-4 shrink-0 text-ink-2" />
        ) : (
          <FolderIcon aria-hidden className="size-4 shrink-0 text-ink-2" />
        )}
        {p.editing ? null : <span className="truncate">{group.name}</span>}
        {active && <ActiveDot label={`${p.activeCount} active in ${group.name}`} />}
        {(p.compact || !p.open) && (
          <span aria-hidden className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {p.count}
          </span>
        )}
      </button>
      {p.editing && (
        <InlineRename
          initial={group.name}
          onDone={p.onRenameDone}
          label={`Rename group ${group.name}`}
        />
      )}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md opacity-0 hover:bg-sunken focus-visible:opacity-100 group-hover/grp:opacity-100 data-[state=open]:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100"
            aria-label={`Group actions for ${group.name}`}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52" side={p.isMobile ? 'bottom' : 'right'} align={p.isMobile ? 'end' : 'start'}>
          <DropdownMenuItem onSelect={p.onRename}>
            <Pencil className="size-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={p.onManageFolders}>
            <FolderCog className="size-4" /> Manage folders
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={p.onToggle}>
            {p.open ? <ChevronsDownUp className="size-4" /> : <ChevronsUpDown className="size-4" />}
            {p.open ? 'Collapse' : 'Expand'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={group.position === 0} onSelect={() => p.onMoveBy(-1)}>
            Move group up
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => p.onMoveBy(1)}>Move group down</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={p.onDelete}>
            <Trash2 className="size-4" /> Delete group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )

  return (
    <li
      ref={sortable.setNodeRef}
      style={
        sortable.transform
          ? { transform: `translate3d(0, ${Math.round(sortable.transform.y)}px, 0)`, transition: sortable.transition }
          : undefined
      }
      className={cn('relative', sortable.isDragging && 'opacity-40')}
      data-group-id={group.id}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('[data-group-item]')) return
        e.preventDefault()
        setMenuOpen(true)
      }}
    >
      {p.compact ? (
        <Tooltip>
          <TooltipTrigger asChild>{header}</TooltipTrigger>
          <TooltipContent side="right">
            {group.name} · {statusText}
          </TooltipContent>
        </Tooltip>
      ) : (
        header
      )}
      {!p.compact && p.open && group.folderBindings.length > 0 && (
        <div className="ml-7 flex flex-wrap gap-1 pb-1 pr-2" aria-label={`Folders for ${group.name}`}>
          {group.folderBindings.map((b) => (
            <span
              key={b.canonicalPath}
              title={b.available === false ? `${b.canonicalPath} (unavailable)` : b.canonicalPath}
              className={cn(
                'inline-flex max-w-full items-center gap-1 truncate rounded bg-sunken px-1.5 py-0.5 text-[11px] text-muted-foreground',
                b.available === false && 'line-through decoration-muted-foreground/60'
              )}
            >
              {b.available === false && <TriangleAlert aria-label="Unavailable" className="size-3 shrink-0 text-warning" />}
              <span className="truncate">{b.displayName}</span>
            </span>
          ))}
          {unavailable > 0 && <span className="sr-only">{unavailable} unavailable folders</span>}
        </div>
      )}
      {p.children}
    </li>
  )
})

function InlineRename({
  initial,
  onDone,
  label,
}: {
  initial: string
  onDone: (name: string | null) => void
  label: string
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (v: string | null) => {
    if (done.current) return
    done.current = true
    onDone(v)
  }
  return (
    <input
      ref={ref}
      aria-label={label}
      data-testid="group-rename-input"
      className="absolute inset-y-0.5 left-12 right-8 rounded border border-ring bg-surface px-1.5 text-sm outline-hidden"
      value={value}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          if (!value.trim()) {
            announce('Group name cannot be empty')
            return
          }
          finish(value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(null)
        }
      }}
      onBlur={() => finish(value.trim() ? value : null)}
    />
  )
}
