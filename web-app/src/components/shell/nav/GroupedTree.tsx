import { useMemo, useState, type ReactNode } from 'react'
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
import { toast } from 'sonner'
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
import { layoutSurface } from '@/lib/groups/domain'
import { useConversationGroups } from '@/lib/groups/store'
import { moveWithFolders, type FolderAdapter } from '@/lib/groups/inherit'
import { useKeepFoldersPrompt } from '@/lib/groups/keepPrompt'
import type { ConversationGroup, GroupSurface } from '@/lib/groups/types'
import { GroupFoldersDialog } from './GroupFoldersDialog'

const UNGROUPED = 'ungrouped'

/** A drop target: a group, or Ungrouped. Lights up while hovered. */
function DropZone({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${id}` })
  return (
    <div
      ref={setNodeRef}
      data-testid={`group-drop-${id}`}
      className={cn(
        'rounded-md transition-[background-color,box-shadow] duration-150',
        isOver && 'bg-acc-tint ring-1 ring-acc/40'
      )}
    >
      {children}
    </div>
  )
}

/** One item row that can be dragged onto a group header. */
function DraggableRow({ id, children }: { id: string; children: ReactNode }) {
  const drag = useDraggable({ id: `item:${id}`, data: { itemId: id } })
  return (
    <li
      ref={drag.setNodeRef}
      {...drag.listeners}
      className={cn('list-none', drag.isDragging && 'opacity-40')}
    >
      <ul>{children}</ul>
    </li>
  )
}

/**
 * Move an item into a group (or out, with null), asking before detaching the
 * folders it inherited, and say where it went.
 */
function useMoveToGroup(
  surface: Extract<GroupSurface, 'cowork' | 'rooms'>,
  adapter: FolderAdapter
) {
  const { t } = useTranslation()
  return async (itemId: string, target: string | null) => {
    const { state } = useConversationGroups.getState()
    const groups = state.surfaces[surface].groups
    const from = state.surfaces[surface].memberships[itemId]?.groupId ?? null
    const fromName = groups.find((g) => g.id === from)?.name ?? ''
    try {
      const moved = await moveWithFolders(surface, itemId, target, adapter, (paths) =>
        useKeepFoldersPrompt.getState().ask(surface, fromName, paths)
      )
      if (!moved) return
      const g = groups.find((x) => x.id === target)
      toast.success(
        g ? t('common:groups.movedTo', { name: g.name }) : t('common:groups.movedOut')
      )
    } catch (err) {
      toast.error(String(err))
    }
  }
}

type NameDialog =
  | { mode: 'create'; itemId?: string }
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
}: {
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
  const keepAsk = useKeepFoldersPrompt((s) =>
    s.request?.surface === surface ? s.request : null
  )
  const answerKeep = useKeepFoldersPrompt((s) => s.answer)
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
    const id = await store.createGroup(surface, trimmed)
    if (id && d.itemId) await move(d.itemId, id)
  }

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
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        {layout.groups.map(({ group, children }) => {
          const open = !group.collapsed
          const visible = open ? children : children.filter(keepVisible)
          return (
            <li
              key={group.id}
              className="group/cg flex list-none flex-col"
              data-testid="nav-group"
              data-group-id={group.id}
            >
              <DropZone id={group.id}>
                <div className="flex h-7 items-center gap-0.5">
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
                    <span className="text-[10.5px] font-normal text-subtle-foreground tabular-nums">
                      {children.length}
                    </span>
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        'ml-auto size-3 shrink-0 transition-transform duration-300 ease-expo',
                        !open && '-rotate-90'
                      )}
                    />
                  </button>
                  <NavGroupAction
                    className="opacity-0 group-hover/cg:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
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
                        className="opacity-0 group-hover/cg:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
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
              <NavCollapse open={visible.length > 0}>
                <ul className="flex flex-col">{visible.map(row)}</ul>
              </NavCollapse>
            </li>
          )
        })}
        {hasGroups ? (
          <li className="flex list-none flex-col" data-testid="nav-ungrouped">
            <DropZone id={UNGROUPED}>
              <div className="flex h-7 items-center px-1 text-xs font-medium text-muted-foreground">
                {t('common:groups.ungrouped')}
              </div>
            </DropZone>
            <ul className="flex flex-col">{layout.recents.map(row)}</ul>
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

      <Dialog open={keepAsk !== null} onOpenChange={(o) => !o && answerKeep(true)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('common:groups.keepTitle')}</DialogTitle>
            <DialogDescription>
              {t('common:groups.keepBody', { name: keepAsk?.groupName })}
            </DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
            {keepAsk?.paths.map((p) => (
              <li key={p} className="truncate" title={p}>
                {p}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => answerKeep(false)}
              data-testid="group-detach-folders"
            >
              {t('common:groups.detach')}
            </Button>
            <Button
              onClick={() => answerKeep(true)}
              data-testid="group-keep-folders"
            >
              {t('common:groups.keep')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
