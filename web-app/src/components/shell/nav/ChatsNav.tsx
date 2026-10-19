import { FadeText } from '@/components/ui/fade-text'
import { groupDragAnnouncements } from '@/lib/dndAnnouncements'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { startHomeProjectsMirror } from '@/lib/groups/homeMirror'
import { useConversationGroups } from '@/lib/groups/store'
import { chatFolderAdapter } from '@/lib/chatFolders'
import { useMoveToGroup } from '@/hooks/useMoveToGroup'
import { GroupFoldersDialog } from '@/components/shell/nav/GroupFoldersDialog'
import { GroupPrompts } from '@/components/shell/nav/GroupPrompts'
import {
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { usePendingDeletes } from '@/lib/undoableAction'
import { useNavigate, useParams } from '@tanstack/react-router'
import {
  CheckSquare,
  ChevronDown,
  FolderPlus,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Trash2,
  FolderOpen,
  Folders,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  NavCollapse,
  NavGroup,
  NavGroupAction,
  NavGroupLabel,
  NavList,
  useCloseDrawer,
  useShellNav,
} from '@/components/shell/nav-kit'
import { Skeleton } from '@/components/ui/skeleton'
import ThreadList, { type ThreadSelection } from '@/containers/ThreadList'
import { forkParentOf } from '@/lib/forkThread'
import { buildNestTree } from '@/lib/nesting'
import { ThreadStatusMark, updatedMs } from '@/containers/ThreadStatusMark'
import AddProjectDialog from '@/containers/dialogs/AddProjectDialog'
import type { ProjectModel } from '@/services/projects/types'
import { DeleteProjectDialog } from '@/containers/dialogs/DeleteProjectDialog'
import { BulkKindDialog } from '@/containers/BulkKindDialog'
import { DeleteSelectedThreadsDialog } from '@/containers/dialogs/DeleteSelectedThreadsDialog'
import { Button } from '@/components/ui/button'
import { useThreads } from '@/hooks/useThreads'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useProjectDialog } from '@/hooks/useProjectDialog'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useChatSessions } from '@/stores/chat-session-store'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/ui/icon'
import type { ThreadFolder } from '@/services/projects/types'

/** One options object for good: a fresh literal each render makes a new sensor,
  which re-renders every draggable row under the DndContext. */
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } }

type ChatFilter = 'all' | 'active'
const RECENT_MS = 60 * 60 * 1000
/** Rows shown per group before "Show N more". */
const PAGE = 12

type Group = {
  id: string
  name: string
  threads: Thread[]
  pinned?: boolean
  folder?: ThreadFolder
}

/** A group header a chat can be dropped on; it lights up while hovered. */
function DropTarget({
  id,
  label,
  children,
}: {
  id: string
  /** The group's name, for the drag announcements. */
  label: string
  children: ReactNode
}) {
  const { setNodeRef, isOver, active } = useDroppable({ id: `group:${id}`, data: { label } })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-md transition-[background-color,box-shadow] duration-150',
        active && 'ring-2 ring-transparent ring-inset',
        isOver && 'bg-acc-tint ring-2 ring-acc/70 ring-inset'
      )}
    >
      {children}
    </div>
  )
}

type ChatGroupSectionProps = {
  group: Group
  isOpen: boolean
  /** The chat open when the group was collapsed (collapsed groups only). */
  collapsedFor: string | null | undefined
  currentThreadId: string | undefined
  streaming: ReadonlySet<string> | undefined
  showAll: boolean
  selection: ThreadSelection | undefined
  isMobile: boolean
  onToggle: (id: string, isOpen: boolean) => void
  onShowMore: (id: string, more: boolean) => void
  onOpenGroup: (projectId: string) => void
  onEdit: (folder: ThreadFolder) => void
  onFolders: (id: string) => void
  onDelete: (folder: ThreadFolder) => void
}

/** One chat group: header, its rows, Show more/less. */
const ChatGroupSection = memo(function ChatGroupSection({
  group: g,
  isOpen,
  collapsedFor,
  currentThreadId,
  streaming,
  showAll,
  selection,
  isMobile,
  onToggle,
  onShowMore,
  onOpenGroup,
  onEdit,
  onFolders,
  onDelete,
}: ChatGroupSectionProps) {
  const { t } = useTranslation()
  // A page is counted in top-level rows: a fork listed under its chat comes
  // with it, never cut off from it by "Show more".
  const roots = useMemo(
    () =>
      buildNestTree(
        g.threads.map((th) => ({ id: th.id, parentId: forkParentOf(th) }))
      ),
    [g.threads]
  )
  // A collapsed group still lists the chat that was open when it was
  // collapsed and any chat that is running, until it stops.
  const visible = useMemo(() => {
    if (!isOpen)
      return g.threads.filter(
        (th) =>
          (collapsedFor === currentThreadId && th.id === currentThreadId) ||
          !!streaming?.has(th.id)
      )
    if (showAll || roots.length <= PAGE) return g.threads
    const keep = new Set(
      roots.slice(0, PAGE).flatMap((r) => [r.id, ...r.nested])
    )
    return g.threads.filter((th) => keep.has(th.id))
  }, [g.threads, roots, isOpen, showAll, collapsedFor, currentThreadId, streaming])
  const hidden = isOpen && !showAll ? Math.max(0, roots.length - PAGE) : 0
  return (
    <div className="flex flex-col" data-testid="chat-group">
      <DropTarget id={g.id} label={g.name}>
      {/* The hover group is the header row only: hovering a chat below must not reveal the folder's controls. */}
      <div className="group/cg flex h-7 items-center gap-0.5" data-testid="chat-group-header">
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => onToggle(g.id, isOpen)}
          className="flex h-[26px] min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          {g.pinned && <Pin className="size-3 shrink-0" aria-hidden />}
          <FadeText>{g.name}</FadeText>
          <span className="text-[length:calc(var(--ui-font-base)*0.65625)] font-normal text-subtle-foreground tabular-nums">
            {g.threads.length}
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              'ml-auto size-3 shrink-0 transition-transform duration-300 ease-expo',
              !isOpen && '-rotate-90'
            )}
          />
        </button>
        {g.folder && (
          <>
            <NavGroupAction
              className="opacity-0 group-hover/cg:opacity-100 group-has-[:focus-visible]/cg:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              aria-label={t('common:shell.newChatIn', { name: g.name })}
              title={t('common:shell.newChatIn', { name: g.name })}
              onClick={() => onOpenGroup(g.folder!.id)}
            >
              <Plus />
            </NavGroupAction>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <NavGroupAction
                  className="opacity-0 group-hover/cg:opacity-100 group-has-[:focus-visible]/cg:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
                  aria-label={t('common:shell.groupOptions')}
                >
                  <MoreHorizontal />
                </NavGroupAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side={isMobile ? 'bottom' : 'right'} className="w-48">
                <DropdownMenuItem
                  onSelect={() => onOpenGroup(g.folder!.id)}
                >
                  <FolderOpen />
                  <span>{t('common:shell.openGroup')}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onEdit(g.folder!)}>
                  <Pencil />
                  <span>{t('common:shell.editGroup')}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onFolders(g.folder!.id)}>
                  <Folders />
                  <span>{t('common:groups.folders')}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onDelete(g.folder!)}>
                  <Trash2 />
                  <span>{t('common:shell.deleteGroup')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
      </DropTarget>
      <NavCollapse open={visible.length > 0}>
        <NavList>
          <ThreadList threads={visible} draggable selection={selection} nested />
        </NavList>
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => onShowMore(g.id, true)}
            className="mt-0.5 ml-[26px] cursor-pointer self-start rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {t('common:shell.showMore', { count: hidden })}
          </button>
        )}
        {showAll && roots.length > PAGE && (
          <button
            type="button"
            onClick={() => onShowMore(g.id, false)}
            className="mt-0.5 ml-[26px] cursor-pointer self-start rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {t('common:shell.showLess')}
          </button>
        )}
      </NavCollapse>
    </div>
  )
})

type ChatGroupListProps = Omit<
  ChatGroupSectionProps,
  'group' | 'isOpen' | 'collapsedFor' | 'showAll' | 'streaming'
> & {
  filter: ChatFilter
  collapsed: Record<string, string | null>
  expandedMore: Record<string, boolean>
}

/** Every chat group, grouped and sorted from the threads store. */
function ChatGroupList({
  filter,
  collapsed,
  expandedMore,
  currentThreadId,
  selection,
  isMobile,
  onToggle,
  onShowMore,
  onOpenGroup,
  onEdit,
  onFolders,
  onDelete,
}: ChatGroupListProps) {
  const { t } = useTranslation()
  const threads = useThreads((s) => s.threads)
  const getFilteredThreads = useThreads((s) => s.getFilteredThreads)
  const folders = useThreadManagement((s) => s.folders)
  const pendingDeletes = usePendingDeletes((s) => s.ids)
  // The running chats as one string: token-by-token session updates leave it
  // unchanged, so they never re-render the sidebar.
  const streamingKey = useChatSessions((s) =>
    Object.keys(s.sessions)
      .filter((id) => s.sessions[id]?.isStreaming)
      .sort()
      .join('\n')
  )
  const streaming = useMemo(
    () => new Set(streamingKey ? streamingKey.split('\n') : []),
    [streamingKey]
  )

  const computedGroups = useMemo<Group[]>(() => {
    const now = Date.now()
    const all = getFilteredThreads('').filter((th) => {
      if (pendingDeletes[th.id]) return false
      if (filter === 'all') return true
      return (
        streaming.has(th.id) ||
        now - updatedMs(th.updated) < RECENT_MS
      )
    })
    const byUpdated = (a: Thread, b: Thread) =>
      (b.updated || 0) - (a.updated || 0)
    const pinned = all.filter((th) => th.isFavorite).sort(byUpdated)
    const rest = all.filter((th) => !th.isFavorite)
    const out: Group[] = []
    if (pinned.length)
      out.push({ id: 'pinned', name: t('common:shell.pinned'), threads: pinned, pinned: true })
    for (const folder of folders) {
      const list = rest
        .filter((th) => th.metadata?.project?.id === folder.id)
        .sort(byUpdated)
      if (list.length || filter === 'all')
        out.push({ id: folder.id, name: folder.name, threads: list, folder })
    }
    const ungrouped = rest
      .filter(
        (th) =>
          !th.metadata?.project ||
          !folders.some((f) => f.id === th.metadata?.project?.id)
      )
      .sort(byUpdated)
    if (ungrouped.length)
      out.push({ id: 'ungrouped', name: t('common:shell.ungrouped'), threads: ungrouped })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, folders, filter, streaming, getFilteredThreads, t, pendingDeletes])

  // A group whose rows did not change keeps its object, so its section (a
  // memo component) skips rendering: a title change re-renders one group.
  const prevGroups = useRef(new Map<string, Group>())
  const groups = useMemo(() => {
    const prev = prevGroups.current
    const next = new Map<string, Group>()
    const out = computedGroups.map((g) => {
      const old = prev.get(g.id)
      const same =
        old &&
        old.name === g.name &&
        old.folder === g.folder &&
        old.pinned === g.pinned &&
        old.threads.length === g.threads.length &&
        old.threads.every((th, i) => th === g.threads[i])
      const kept = same ? old : g
      next.set(g.id, kept)
      return kept
    })
    prevGroups.current = next
    return out
  }, [computedGroups])

  return (
    <>
    {groups.map((g) => {
      const isOpen = collapsed[g.id] === undefined
      return (
        <ChatGroupSection
          key={g.id}
          group={g}
          isOpen={isOpen}
          collapsedFor={isOpen ? undefined : collapsed[g.id]}
          // Only a collapsed group shows the open and running chats.
          currentThreadId={isOpen ? undefined : currentThreadId}
          streaming={isOpen ? undefined : streaming}
          showAll={!!expandedMore[g.id]}
          selection={selection}
          isMobile={isMobile}
          onToggle={onToggle}
          onShowMore={onShowMore}
          onOpenGroup={onOpenGroup}
          onEdit={onEdit}
          onFolders={onFolders}
          onDelete={onDelete}
        />
      )
    })}
    </>
  )
}

/**
 * The Chats section: Pinned, one collapsible group per project, then the
 * chats in no project. A collapsed group keeps showing the chat that was open
 * when it was collapsed, until another chat or group is chosen, and any chat
 * that is still running, until its run ends.
 */
export function ChatsNav() {
  const { t } = useTranslation()
  // Keeps each chat's metadata.project and the projects list in step with its
  // Home group; without it a chat moved into a group stayed in Ungrouped.
  useEffect(() => startHomeProjectsMirror(), [])
  const navigate = useNavigate()
  const { isMobile } = useShellNav()
  const closeDrawer = useCloseDrawer()
  // Only what the header needs; the rows subscribe in ChatGroupList, so a
  // title or timestamp change never re-renders the drag context around them.
  const hasSeveralThreads = useThreads((s) => Object.keys(s.threads).length > 1)
  const hasNoThreads = useThreads((s) => Object.keys(s.threads).length === 0)
  const isLoadingThreads = useThreads((s) => s.isLoadingThreads)
  const hasBulkThreads = useThreads((s) =>
    Object.keys(s.threads).some((id) => id !== TEMPORARY_CHAT_ID)
  )
  const [bulkOpen, setBulkOpen] = useState(false)
  const deleteThread = useThreads((s) => s.deleteThread)
  const folders = useThreadManagement((s) => s.folders)
  const addFolder = useThreadManagement((s) => s.addFolder)
  const updateFolder = useThreadManagement((s) => s.updateFolder)
  const {
    open: projectDialogOpen,
    noun: projectDialogNoun,
    setOpen: setProjectDialogOpen,
  } = useProjectDialog()
  const currentThreadId = useParams({
    strict: false,
    select: (params) => params.threadId as string | undefined,
  })

  const toggleFavorite = useThreads((s) => s.toggleFavorite)
  // A small movement starts a drag, so a click on a row still opens it.
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS)
  )
  const [filter, setFilter] = useState<ChatFilter>('all')
  const [collapsed, setCollapsed] = useState<Record<string, string | null>>({})
  const [expandedMore, setExpandedMore] = useState<Record<string, boolean>>({})
  const [editing, setEditing] = useState<ThreadFolder | null>(null)
  const [deleting, setDeleting] = useState<ThreadFolder | null>(null)
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  // Bulk delete: while selecting, rows toggle instead of opening.
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)
  const selection = useMemo(
    () =>
      selecting
        ? {
            selected,
            toggle: (id: string) =>
              setSelected((prev) => {
                const next = new Set(prev)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              }),
          }
        : undefined,
    [selecting, selected]
  )
  const stopSelecting = () => {
    setSelecting(false)
    setSelected(new Set())
  }
  // A chat group is the Home group of the same id; its folders live there.
  const [foldersOf, setFoldersOf] = useState<string | null>(null)
  const foldersGroup = useConversationGroups((s) =>
    foldersOf ? s.state.surfaces.home.groups.find((g) => g.id === foldersOf) : undefined
  )
  const moveChat = useMoveToGroup('home', chatFolderAdapter)

  /** Dropping a chat on a group moves it there; on Pinned it pins it. */
  const onDragEnd = (e: DragEndEvent) => {
    const threadId = e.active.data.current?.threadId as string | undefined
    const target = typeof e.over?.id === 'string' ? e.over.id.replace(/^group:/, '') : null
    if (!threadId || !target) return
    const thread = useThreads.getState().threads[threadId]
    if (!thread) return
    if (target === 'pinned') {
      if (!thread.isFavorite) toggleFavorite(threadId)
      return
    }
    if (target === 'ungrouped') {
      if (thread.isFavorite) toggleFavorite(threadId)
      // Through the groups store (the mirror clears metadata.project), so
      // the folders the chat got from its group are asked about.
      if (thread.metadata?.project) void moveChat(threadId, null)
      return
    }
    const folder = folders.find((f) => f.id === target)
    if (!folder || thread.metadata?.project?.id === folder.id) return
    void moveChat(threadId, folder.id)
  }

  const currentRef = useRef(currentThreadId)
  currentRef.current = currentThreadId
  const toggleGroup = useCallback(
    (id: string, isOpen: boolean) =>
      setCollapsed((c) => ({
        ...c,
        // Collapsing remembers the chat open right now, so it stays visible.
        [id]: isOpen ? (currentRef.current ?? null) : undefined!,
      })),
    []
  )
  const showMore = useCallback(
    (id: string, more: boolean) => setExpandedMore((m) => ({ ...m, [id]: more })),
    []
  )
  const openRef = useRef<(projectId: string) => void>(() => {})
  openRef.current = (projectId: string) => {
    navigate({ to: '/project/$projectId', params: { projectId } })
    closeDrawer()
  }
  const openGroup = useCallback((projectId: string) => openRef.current(projectId), [])

  const newChat = () => {
    useAgentMode.getState().removeThread(TEMPORARY_CHAT_ID)
    navigate({ to: route.home })
    closeDrawer()
  }

  const handleCreateProject = async (
    name: string,
    assistantId?: string,
    model?: ProjectModel
  ) => {
    const created = await addFolder(name, assistantId, model)
    setProjectDialogOpen(false)
    navigate({ to: '/project/$projectId', params: { projectId: created.id } })
    closeDrawer()
  }


  return (
    <NavGroup data-testid="nav-chats">
      <div className="-mb-0.5 flex items-center justify-between">
        <NavGroupLabel>{t('common:chats')}</NavGroupLabel>
        <span className="flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <NavGroupAction aria-label={t('common:shell.newChatOrGroup')} title={t('common:shell.newChatOrGroup')}>
                <Icon name="x-plus" size={14} />
              </NavGroupAction>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side={isMobile ? 'bottom' : 'right'} className="w-48">
              <DropdownMenuItem onSelect={newChat}>
                <MessageSquarePlus />
                <span>{t('common:newChat')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setProjectDialogOpen(true, 'group')}>
                <FolderPlus />
                <span>{t('common:projects.newGroup')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <NavGroupAction
            aria-label={t('common:shell.searchChats')}
            title={t('common:shell.searchChats')}
            onClick={() => useSearchDialog.getState().setOpen(true)}
          >
            <Icon name="x-search" size={14} />
          </NavGroupAction>
          <DropdownMenu open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
            <DropdownMenuTrigger asChild>
              <NavGroupAction
                aria-label={t('common:shell.filter')}
                title={t('common:shell.filter')}
                data-pressed={filter !== 'all'}
              >
                <Icon name="x-sliders" size={14} />
              </NavGroupAction>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side={isMobile ? 'bottom' : 'right'} className="w-60">
              <DropdownMenuLabel>{t('common:shell.show')}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={filter}
                onValueChange={(v) => setFilter(v as ChatFilter)}
              >
                <DropdownMenuRadioItem value="all">{t('common:shell.filterAll')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="active">{t('common:shell.filterActive')}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t('common:shell.statusIcons')}</DropdownMenuLabel>
              <div className="flex flex-col gap-1.5 px-2 pt-1 pb-2 text-xs text-secondary-foreground">
                {(['active', 'recent', 'wait', 'pr', 'merged', 'closed', 'draft'] as const).map((s) => (
                  <div key={s} className="flex items-center gap-2">
                    <ThreadStatusMark status={s} />
                    <span>{t(`common:shell.status.${s}`)}</span>
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <span className="size-3.5" />
                  <span>{t('common:shell.status.none')}</span>
                </div>
              </div>
              <DropdownMenuSeparator />
              {hasSeveralThreads && (
                <DropdownMenuItem onSelect={() => setSelecting(true)}>
                  <CheckSquare className="size-4" />
                  <span>{t('chat:bulkDelete.select')}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                variant="destructive"
                disabled={!hasBulkThreads}
                onSelect={() => setBulkOpen(true)}
                data-testid="chats-delete-all"
              >
                <Trash2 className="size-4" />
                <span>{t('settings:bulk.deleteAllMenu')}</span>
              </DropdownMenuItem>
              {!hasBulkThreads && (
                <p className="px-2 pb-1 text-xs text-muted-foreground">
                  {t('settings:bulk.deleteAllEmpty')}
                </p>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>

      {selecting && (
        <div
          className="mb-1 flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
          data-testid="bulk-select-bar"
        >
          <span className="min-w-0 flex-1 truncate">
            {t('chat:bulkDelete.selected', { count: selected.size })}
          </span>
          <Button
            variant="destructive"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={selected.size === 0}
            onClick={() => setConfirmBulk(true)}
          >
            {t('common:delete')}
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={stopSelecting}>
            {t('common:cancel')}
          </Button>
        </div>
      )}

      {hasNoThreads && isLoadingThreads ? (
        <div className="flex flex-col gap-1.5 px-1" aria-busy>
          {[70, 55, 80].map((w) => (
            <Skeleton key={w} className="h-5 rounded-md" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          onDragEnd={onDragEnd}
          accessibility={{ announcements: groupDragAnnouncements(t) }}
        >
        <div className="flex flex-col gap-1">
          <ChatGroupList
            filter={filter}
            collapsed={collapsed}
            expandedMore={expandedMore}
            currentThreadId={currentThreadId}
            selection={selection}
            isMobile={isMobile}
            onToggle={toggleGroup}
            onShowMore={showMore}
            onOpenGroup={openGroup}
            onEdit={setEditing}
            onFolders={setFoldersOf}
            onDelete={setDeleting}
          />
        </div>
        </DndContext>
      )}

      <AddProjectDialog
        open={projectDialogOpen}
        onOpenChange={(o) => setProjectDialogOpen(o, projectDialogNoun)}
        editingKey={null}
        noun={projectDialogNoun}
        onSave={handleCreateProject}
      />
      <AddProjectDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        editingKey={editing?.id ?? null}
        initialData={editing ?? undefined}
        noun="group"
        onSave={async (name: string, assistantId?: string, model?: ProjectModel) => {
          if (editing) await updateFolder(editing.id, name, assistantId, model)
          setEditing(null)
        }}
      />
      <DeleteSelectedThreadsDialog
        ids={[...selected]}
        onDelete={(id) => deleteThread(id)}
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        onDone={stopSelecting}
      />
      {bulkOpen && (
        <BulkKindDialog
          kind="thread"
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            const open = currentThreadId
            if (open && !useThreads.getState().threads[open])
              void navigate({ to: route.home })
          }}
        />
      )}
      <GroupPrompts surface="home" />
      {foldersGroup && (
        <GroupFoldersDialog
          surface="home"
          group={foldersGroup}
          open
          onOpenChange={(o) => !o && setFoldersOf(null)}
        />
      )}
      <DeleteProjectDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        projectId={deleting?.id}
        projectName={deleting?.name}
      />
    </NavGroup>
  )
}
