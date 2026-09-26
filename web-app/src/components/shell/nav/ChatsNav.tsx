import { FadeText } from '@/components/ui/fade-text'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
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
  useShellNav,
} from '@/components/shell/nav-kit'
import { Skeleton } from '@/components/ui/skeleton'
import ThreadList from '@/containers/ThreadList'
import { ThreadStatusMark, updatedMs } from '@/containers/ThreadStatusMark'
import AddProjectDialog from '@/containers/dialogs/AddProjectDialog'
import { DeleteProjectDialog } from '@/containers/dialogs/DeleteProjectDialog'
import { DeleteAllThreadsDialog } from '@/containers/dialogs/DeleteAllThreadsDialog'
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
function DropTarget({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: `group:${id}` })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-md transition-[background-color,box-shadow] duration-150',
        active && 'ring-1 ring-transparent',
        isOver && 'bg-acc-tint ring-acc/40'
      )}
    >
      {children}
    </div>
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
  const threads = useThreads((s) => s.threads)
  const getFilteredThreads = useThreads((s) => s.getFilteredThreads)
  const isLoadingThreads = useThreads((s) => s.isLoadingThreads)
  const deleteAllThreads = useThreads((s) => s.deleteAllThreads)
  const { folders, addFolder, updateFolder } = useThreadManagement()
  const streaming = useChatSessions((s) => s.sessions)
  const { open: projectDialogOpen, setOpen: setProjectDialogOpen } =
    useProjectDialog()
  const currentThreadId = useParams({
    strict: false,
    select: (params) => params.threadId as string | undefined,
  })

  const pendingDeletes = usePendingDeletes((s) => s.ids)
  const toggleFavorite = useThreads((s) => s.toggleFavorite)
  // A small movement starts a drag, so a click on a row still opens it.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )
  const [filter, setFilter] = useState<ChatFilter>('all')
  const [collapsed, setCollapsed] = useState<Record<string, string | null>>({})
  const [expandedMore, setExpandedMore] = useState<Record<string, boolean>>({})
  const [editing, setEditing] = useState<ThreadFolder | null>(null)
  const [deleting, setDeleting] = useState<ThreadFolder | null>(null)
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  // A chat group is the Home group of the same id; its folders live there.
  const [foldersOf, setFoldersOf] = useState<string | null>(null)
  const foldersGroup = useConversationGroups((s) =>
    foldersOf ? s.state.surfaces.home.groups.find((g) => g.id === foldersOf) : undefined
  )
  const moveChat = useMoveToGroup('home', chatFolderAdapter)

  const groups = useMemo<Group[]>(() => {
    const now = Date.now()
    const all = getFilteredThreads('').filter((th) => {
      if (pendingDeletes[th.id]) return false
      if (filter === 'all') return true
      return (
        streaming[th.id]?.isStreaming ||
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

  /** Dropping a chat on a group moves it there; on Pinned it pins it. */
  const onDragEnd = (e: DragEndEvent) => {
    const threadId = e.active.data.current?.threadId as string | undefined
    const target = typeof e.over?.id === 'string' ? e.over.id.replace(/^group:/, '') : null
    if (!threadId || !target) return
    const thread = threads[threadId]
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

  const toggleGroup = (id: string, isOpen: boolean) =>
    setCollapsed((c) => ({
      ...c,
      // Collapsing remembers the chat open right now, so it stays visible.
      [id]: isOpen ? (currentThreadId ?? null) : undefined!,
    }))

  const newChat = () => {
    useAgentMode.getState().removeThread(TEMPORARY_CHAT_ID)
    navigate({ to: route.home })
  }

  const handleCreateProject = async (name: string, assistantId?: string) => {
    const created = await addFolder(name, assistantId)
    setProjectDialogOpen(false)
    navigate({ to: '/project/$projectId', params: { projectId: created.id } })
  }

  const empty = groups.every((g) => g.threads.length === 0)

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
              <DropdownMenuItem onSelect={() => setProjectDialogOpen(true)}>
                <FolderPlus />
                <span>{t('common:projects.new')}</span>
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
              {Object.keys(threads).length > 1 && (
                <>
                  <DropdownMenuSeparator />
                  <DeleteAllThreadsDialog
                    onDeleteAll={deleteAllThreads}
                    onDropdownClose={() => setFilterMenuOpen(false)}
                  />
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>

      {empty && isLoadingThreads ? (
        <div className="flex flex-col gap-1.5 px-1" aria-busy>
          {[70, 55, 80].map((w) => (
            <Skeleton key={w} className="h-5 rounded-md" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="flex flex-col gap-1">
          {groups.map((g) => {
            const isOpen = collapsed[g.id] === undefined
            // A collapsed group still lists the chat that was open when it
            // was collapsed and any chat that is running, until it stops.
            const kept = isOpen
              ? []
              : g.threads.filter(
                  (th) =>
                    (collapsed[g.id] === currentThreadId &&
                      th.id === currentThreadId) ||
                    streaming[th.id]?.isStreaming
                )
            const showAll = expandedMore[g.id]
            const visible = isOpen
              ? showAll
                ? g.threads
                : g.threads.slice(0, PAGE)
              : kept
            const hidden = isOpen ? g.threads.length - visible.length : 0
            return (
              <div key={g.id} className="group/cg flex flex-col" data-testid="chat-group">
                <DropTarget id={g.id}>
                <div className="flex h-7 items-center gap-0.5">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => toggleGroup(g.id, isOpen)}
                    className="flex h-[26px] min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40"
                  >
                    {g.pinned && <Pin className="size-3 shrink-0" aria-hidden />}
                    <FadeText>{g.name}</FadeText>
                    <span className="text-[10.5px] font-normal text-subtle-foreground tabular-nums">
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
                        className="opacity-0 group-hover/cg:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                        aria-label={t('common:shell.newChatIn', { name: g.name })}
                        title={t('common:shell.newChatIn', { name: g.name })}
                        onClick={() =>
                          navigate({ to: '/project/$projectId', params: { projectId: g.folder!.id } })
                        }
                      >
                        <Plus />
                      </NavGroupAction>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <NavGroupAction
                            className="opacity-0 group-hover/cg:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
                            aria-label={t('common:shell.groupOptions')}
                          >
                            <MoreHorizontal />
                          </NavGroupAction>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" side={isMobile ? 'bottom' : 'right'} className="w-48">
                          <DropdownMenuItem
                            onSelect={() =>
                              navigate({ to: '/project/$projectId', params: { projectId: g.folder!.id } })
                            }
                          >
                            <FolderOpen />
                            <span>{t('common:shell.openGroup')}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setEditing(g.folder!)}>
                            <Pencil />
                            <span>{t('common:shell.editGroup')}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setFoldersOf(g.folder!.id)}>
                            <Folders />
                            <span>{t('common:groups.folders')}</span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(g.folder!)}>
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
                    <ThreadList threads={visible} draggable />
                  </NavList>
                  {hidden > 0 && (
                    <button
                      type="button"
                      onClick={() => setExpandedMore((m) => ({ ...m, [g.id]: true }))}
                      className="mt-0.5 ml-[26px] cursor-pointer self-start rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {t('common:shell.showMore', { count: hidden })}
                    </button>
                  )}
                  {showAll && g.threads.length > PAGE && (
                    <button
                      type="button"
                      onClick={() => setExpandedMore((m) => ({ ...m, [g.id]: false }))}
                      className="mt-0.5 ml-[26px] cursor-pointer self-start rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {t('common:shell.showLess')}
                    </button>
                  )}
                </NavCollapse>
              </div>
            )
          })}
        </div>
        </DndContext>
      )}

      <AddProjectDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        editingKey={null}
        onSave={handleCreateProject}
      />
      <AddProjectDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        editingKey={editing?.id ?? null}
        initialData={editing ?? undefined}
        onSave={async (name: string, assistantId?: string) => {
          if (editing) await updateFolder(editing.id, name, assistantId)
          setEditing(null)
        }}
      />
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
