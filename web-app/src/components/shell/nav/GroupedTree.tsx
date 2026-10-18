import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { groupDragAnnouncements } from '@/lib/dndAnnouncements'
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  ChevronDown,
  FolderInput,
  FolderPlus,
  Folders,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import {
  NavButton,
  NavCollapse,
  NavGroupAction,
  NavItem,
  useShellNav,
} from '@/components/shell/nav-kit'
import { FadeText } from '@/components/ui/fade-text'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { descendantIds, groupDepth, layoutSurface } from '@/lib/groups/domain'
import { useConversationGroups } from '@/lib/groups/store'
import type { FolderAdapter } from '@/lib/groups/inherit'
import { useMoveToGroup } from '@/hooks/useMoveToGroup'
import {
  MAX_GROUP_DEPTH,
  type ConversationGroup,
  type GroupLayout,
  type GroupSurface,
} from '@/lib/groups/types'
import { GroupFoldersDialog } from './GroupFoldersDialog'
import { GroupPrompts } from './GroupPrompts'

const UNGROUPED = 'ungrouped'

/** Whether a group or any group under it holds an item `keepVisible` wants. */
function holdsKept(
  node: GroupLayout<string>,
  keepVisible: (id: string) => boolean
): boolean {
  return (
    node.children.some(keepVisible) ||
    node.subgroups.some((n) => holdsKept(n, keepVisible))
  )
}

/** A drop target: a group, or Ungrouped. Lights up while hovered. */
function DropZone({
  id,
  label,
  children,
}: {
  id: string
  /** The group's name, for the drag announcements. */
  label: string
  children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${id}`, data: { label } })
  return (
    <div
      ref={setNodeRef}
      data-testid={`group-drop-${id}`}
      className={cn(
        'rounded-md transition-[background-color,box-shadow] duration-150',
        isOver && 'bg-acc-tint ring-2 ring-acc/70 ring-inset'
      )}
    >
      {children}
    </div>
  )
}

/** One item row that can be dragged onto a group header. */
function DraggableRow({ id, children }: { id: string; children: ReactNode }) {
  const node = useRef<HTMLLIElement | null>(null)
  const drag = useDraggable({
    id: `item:${id}`,
    // Read when announced: the row's visible title.
    data: { itemId: id, label: () => node.current?.innerText.split('\n')[0] },
  })
  return (
    <li
      ref={(el) => {
        node.current = el
        drag.setNodeRef(el)
      }}
      {...drag.listeners}
      className={cn('list-none', drag.isDragging && 'opacity-40')}
    >
      <ul>{children}</ul>
    </li>
  )
}

type NameDialog =
  | { mode: 'create'; itemId?: string; parentId?: string }
  | { mode: 'rename'; group: ConversationGroup }

/**
 * Groups for Cowork sessions and Rooms, on the redesigned sidebar: one
 * collapsible header per group (its collapsed state is saved), then the items
 * in no group. Items are dragged onto a header to join it, or onto Ungrouped
 * to leave; a group's "+" starts a new item in it, and its menu renames it,
 * edits its folders or deletes it. An item that joins a group gets the
 * group's folders attached (see lib/groups/inherit); leaving asks whether to
 * keep them.
 *
 * Rendered inside the tree's list: every child is an `<li>`.
 */
export function GroupedTree({
  surface,
  ids,
  renderItem,
  keepVisible,
  adapter,
  onNewInGroup,
  newInLabelKey,
  showNewGroup,
  newGroupRequest = 0,
  onNewGroupRequestHandled,
}: {
  /**
   * Nonzero: open the New group dialog now, for a control outside the tree
   * (a menu, a right-click). Reported back as handled so a remount does not
   * open it again.
   */
  newGroupRequest?: number
  onNewGroupRequestHandled?: () => void
  surface: Extract<GroupSurface, 'cowork' | 'rooms'>
  /** Items to list, in recency order. */
  ids: string[]
  renderItem: (id: string) => ReactNode
  /** Items still listed under a collapsed group (open or running). */
  keepVisible: (id: string) => boolean
  adapter: FolderAdapter
  onNewInGroup: (groupId: string) => void
  newInLabelKey: 'common:groups.newSessionIn' | 'common:groups.newRoomIn'
  /** Show the "New group" row. */
  showNewGroup: boolean
}) {
  const { t } = useTranslation()
  const { isMobile } = useShellNav()
  const data = useConversationGroups((s) => s.state.surfaces[surface])
  const layout = useMemo(
    () => layoutSurface(data, ids, (id) => id),
    [data, ids]
  )
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null)
  const [name, setName] = useState('')
  const [deleting, setDeleting] = useState<ConversationGroup | null>(null)
  const [foldersOf, setFoldersOf] = useState<string | null>(null)
  // While a row is dragged, Ungrouped stays on screen as a drop target even
  // when nothing is in it.
  const [dragging, setDragging] = useState(false)
  const move = useMoveToGroup(surface, adapter)

  const onDragEnd = (e: DragEndEvent) => {
    const itemId = e.active.data.current?.itemId as string | undefined
    const over = typeof e.over?.id === 'string' ? e.over.id : null
    if (!itemId || !over?.startsWith('group:')) return
    const target = over.slice('group:'.length)
    void move(itemId, target === UNGROUPED ? null : target)
  }

  const openName = (d: NameDialog) => {
    setName(d.mode === 'rename' ? d.group.name : '')
    setNameDialog(d)
  }
  const submitName = async () => {
    const d = nameDialog
    const trimmed = name.trim()
    if (!d || !trimmed) return
    setNameDialog(null)
    const store = useConversationGroups.getState()
    if (d.mode === 'rename') {
      await store.renameGroup(surface, d.group.id, trimmed)
      return
    }
    const id = await store.createGroup(surface, trimmed, { parentId: d.parentId })
    if (id && d.itemId) await move(d.itemId, id)
  }

  useEffect(() => {
    if (!newGroupRequest) return
    setName('')
    setNameDialog({ mode: 'create' })
    onNewGroupRequestHandled?.()
  }, [newGroupRequest, onNewGroupRequestHandled])

  const toggle = (g: ConversationGroup) =>
    void useConversationGroups
      .getState()
      .setCollapsed(surface, g.id, !g.collapsed)

  const deleteGroup = async () => {
    if (!deleting) return
    await useConversationGroups.getState().deleteGroup(surface, deleting.id)
    setDeleting(null)
  }

  const hasGroups = layout.groups.length > 0
  const row = (id: string) =>
    hasGroups ? (
      <DraggableRow key={id} id={id}>
        {renderItem(id)}
      </DraggableRow>
    ) : (
      <li key={id} className="list-none">
        <ul>{renderItem(id)}</ul>
      </li>
    )
  const foldersGroup = data.groups.find((g) => g.id === foldersOf)

  const renderGroup = (
    { group, children, subgroups }: GroupLayout<string>,
    depth: number,
    // An ancestor is collapsed: this group only shows its kept items, however
    // it is set itself.
    ancestorCollapsed = false
  ): ReactNode => {
      const open = !group.collapsed && !ancestorCollapsed
      const visible = open ? children : children.filter(keepVisible)
      const shownSubs = open
        ? subgroups
        : subgroups.filter((n) => holdsKept(n, keepVisible))
      const hasSub = shownSubs.length > 0
      return (
        <li
          key={group.id}
          className="flex list-none flex-col"
          data-testid="nav-group"
          data-group-id={group.id}
        >
          <DropZone id={group.id} label={group.name}>
            <div className="group/cg flex h-7 items-center gap-0.5 pl-2">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(group)}
                className="flex h-[26px] min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-xs font-medium text-muted-foreground transition-colors outline-hidden hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                {group.folderBindings.length > 0 && (
                  <Folders aria-hidden className="size-3 shrink-0" />
                )}
                <FadeText>{group.name}</FadeText>
                <span className="text-[length:calc(var(--ui-font-base)*0.65625)] font-normal text-subtle-foreground tabular-nums">
                  {children.length}
                </span>
              </button>
              {/* The chevron rests at the far right; the row's actions
                  take its place on hover and push it left. */}
              <NavGroupAction
                tabIndex={-1}
                aria-hidden
                onClick={() => toggle(group)}
              >
                <ChevronDown
                  className={cn(
                    'transition-transform duration-300 ease-expo',
                    !open && '-rotate-90'
                  )}
                />
              </NavGroupAction>
              <NavGroupAction
                className="hidden group-focus-within/cg:grid group-hover/cg:grid pointer-coarse:grid"
                aria-label={t(newInLabelKey, { name: group.name })}
                title={t(newInLabelKey, { name: group.name })}
                onClick={() => onNewInGroup(group.id)}
                data-testid="group-new-item"
              >
                <Plus />
              </NavGroupAction>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <NavGroupAction
                    className="hidden group-focus-within/cg:grid group-hover/cg:grid data-[state=open]:grid pointer-coarse:grid"
                    aria-label={t('common:groups.options')}
                  >
                    <MoreHorizontal />
                  </NavGroupAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  side={isMobile ? 'bottom' : 'right'}
                  className="w-48"
                >
                  <DropdownMenuItem
                    onSelect={() => openName({ mode: 'rename', group })}
                  >
                    <Pencil />
                    <span>{t('common:groups.renameGroup')}</span>
                  </DropdownMenuItem>
                    {depth < MAX_GROUP_DEPTH && (
                      <DropdownMenuItem
                        data-testid="group-new-subfolder"
                        onSelect={() => openName({ mode: 'create', parentId: group.id })}
                      >
                        <FolderPlus />
                        <span>{t('common:groups.newSubfolder')}</span>
                      </DropdownMenuItem>
                    )}
                    <MoveGroupSub surface={surface} group={group} />
                  <DropdownMenuItem onSelect={() => setFoldersOf(group.id)}>
                    <Folders />
                    <span>{t('common:groups.folders')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDeleting(group)}
                  >
                    <Trash2 />
                    <span>{t('common:groups.deleteGroup')}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </DropZone>
          <NavCollapse open={visible.length > 0 || hasSub}>
          <ul className="flex flex-col gap-0.5 pl-2">
            {shownSubs.map((n) => renderGroup(n, depth + 1, !open))}
            {visible.map(row)}
          </ul>
        </NavCollapse>
        </li>
      )
  }

  return (
    <>
      {showNewGroup && (
        <NavItem>
          <NavButton
            size="sub"
            onClick={() => openName({ mode: 'create' })}
            data-testid={`${surface}-new-group`}
          >
            <FolderPlus aria-hidden className="size-3.5" />
            <span>{t('common:groups.newGroup')}</span>
          </NavButton>
        </NavItem>
      )}
      <DndContext
        sensors={sensors}
        accessibility={{ announcements: groupDragAnnouncements(t) }}
        onDragStart={() => setDragging(true)}
        onDragCancel={() => setDragging(false)}
        onDragEnd={(e) => {
          setDragging(false)
          onDragEnd(e)
        }}
      >
        {layout.groups.map((node) => renderGroup(node, 1))}
        {hasGroups && (layout.recents.length > 0 || dragging) ? (
          <li className="flex list-none flex-col" data-testid="nav-ungrouped">
            <DropZone id={UNGROUPED} label={t('common:groups.ungrouped')}>
              <div className="flex h-7 items-center px-1 text-xs font-medium text-muted-foreground">
                {t('common:groups.ungrouped')}
              </div>
            </DropZone>
            <ul className="flex flex-col gap-0.5">{layout.recents.map(row)}</ul>
          </li>
        ) : (
          layout.recents.map(row)
        )}
      </DndContext>

      <Dialog
        open={nameDialog !== null}
        onOpenChange={(o) => !o && setNameDialog(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {nameDialog?.mode === 'rename'
                ? t('common:groups.renameGroup')
                : t('common:groups.newGroup')}
            </DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void submitName()
            }}
          >
            <Input
              autoFocus
              aria-label={t('common:groups.groupName')}
              placeholder={t('common:groups.groupName')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setNameDialog(null)}
              >
                {t('common:cancel')}
              </Button>
              <Button type="submit" disabled={!name.trim()}>
                {nameDialog?.mode === 'rename'
                  ? t('common:groups.rename')
                  : t('common:groups.createGroup')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t('common:groups.deleteTitle', { name: deleting?.name })}
            </DialogTitle>
            <DialogDescription>{t('common:groups.deleteBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('common:cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void deleteGroup()}>
              {t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GroupPrompts surface={surface} />

      {foldersGroup && (
        <GroupFoldersDialog
          surface={surface}
          group={foldersGroup}
          open
          onOpenChange={(o) => !o && setFoldersOf(null)}
        />
      )}
    </>
  )
}

/**
 * "Move into folder" for a group's menu: top level, or any group that is not
 * the group itself or one of its own sub-groups and leaves the whole subtree
 * within the depth cap.
 */
function MoveGroupSub({
  surface,
  group,
}: {
  surface: Extract<GroupSurface, 'cowork' | 'rooms'>
  group: ConversationGroup
}) {
  const { t } = useTranslation()
  const data = useConversationGroups((s) => s.state.surfaces[surface])
  const blocked = descendantIds(data, group.id)
  blocked.add(group.id)
  // Height of this group's own subtree (1 for a leaf).
  const height = (id: string, guard = 0): number =>
    guard > MAX_GROUP_DEPTH
      ? 1
      : 1 +
        Math.max(
          0,
          ...data.groups.filter((g) => g.parentId === id).map((g) => height(g.id, guard + 1))
        )
  const own = height(group.id)
  const targets = [...data.groups]
    .sort((a, b) => a.position - b.position)
    .filter((g) => !blocked.has(g.id) && groupDepth(data, g.id) + own <= MAX_GROUP_DEPTH)
  const set = (parentId: string | null) =>
    void useConversationGroups.getState().setGroupParent(surface, group.id, parentId)
  if (targets.length === 0 && group.parentId === null) return null
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="group-move-into">
        <FolderInput />
        <span>{t('common:groups.moveInto')}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        {targets.map((g) => (
          <DropdownMenuItem
            key={g.id}
            disabled={g.id === group.parentId}
            onSelect={() => set(g.id)}
          >
            <FadeText>{g.name}</FadeText>
          </DropdownMenuItem>
        ))}
        {targets.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem disabled={group.parentId === null} onSelect={() => set(null)}>
          <span>{t('common:groups.topLevel')}</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/**
 * "Move to group" for an item's row menu: every group of the surface, "No
 * group", and "New group…". Goes through the same folder handling as a drag.
 */
export function MoveToGroupSub({
  surface,
  itemId,
  adapter,
}: {
  surface: Extract<GroupSurface, 'cowork' | 'rooms'>
  itemId: string
  adapter: FolderAdapter
}) {
  const { t } = useTranslation()
  const data = useConversationGroups((s) => s.state.surfaces[surface])
  const current = data.memberships[itemId]?.groupId ?? null
  const groups = [...data.groups].sort((a, b) => a.position - b.position)
  const moveTo = useMoveToGroup(surface, adapter).bind(null, itemId)
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FolderInput />
        <span>{t('common:groups.moveTo')}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        {groups.map((g) => (
          <DropdownMenuItem
            key={g.id}
            disabled={g.id === current}
            onSelect={() => void moveTo(g.id)}
          >
            <FadeText>{g.name}</FadeText>
          </DropdownMenuItem>
        ))}
        {groups.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem disabled={current === null} onSelect={() => void moveTo(null)}>
          <span>{t('common:groups.noGroup')}</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
