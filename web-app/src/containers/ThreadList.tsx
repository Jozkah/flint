import {
  Check,
  Copy,
  Folder,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react'
import { useThreads } from '@/hooks/useThreads'
import { useIsThreadActive } from '@/hooks/useAppState'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useChatSessions } from '@/stores/chat-session-store'
import { useMessages } from '@/hooks/useMessages'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useEffect, useRef } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import {
  NavAction,
  NavButton,
  NavItem,
  useShellNav,
} from '@/components/shell/nav-kit'
import {
  ThreadStatusMark,
  updatedMs,
  useThreadStatus,
} from '@/containers/ThreadStatusMark'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { useDraggable } from '@dnd-kit/core'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { memo, useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { RenameThreadDialog, DeleteThreadDialog } from '@/containers/dialogs'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/ui/icon'
import { ThreadMessage } from '@janhq/core'
import { useConversationGroups } from '@/lib/groups/store'
import AddProjectDialog from '@/containers/dialogs/AddProjectDialog'

const ThreadItem = memo(
  ({
    thread,
    isMobile,
    currentProjectId,
    draggable = false,
  }: {
    thread: Thread
    isMobile: boolean
    currentProjectId?: string
    draggable?: boolean
  }) => {
    // Rows in the sidebar can be dropped on a chat group. Only the pointer
    // listeners are applied: the link stays the row's one focusable element,
    // and a short press is still a click (the sensor waits for movement).
    const drag = useDraggable({
      id: thread.id,
      data: { threadId: thread.id },
      disabled: !draggable,
    })
    const deleteThread = useThreads((state) => state.deleteThread)
    const renameThread = useThreads((state) => state.renameThread)
    const getFolderById = useThreadManagement().getFolderById
    const { folders, addFolder } = useThreadManagement()
    const { t } = useTranslation()
    const [menuOpen, setMenuOpen] = useState(false)
    const [renameOpen, setRenameOpen] = useState(false)
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

    const serviceHub = useServiceHub()
    const getMessages = useMessages((state) => state.getMessages)
    const setMessages = useMessages((state) => state.setMessages)

    // Use a ref to track if messages have been loaded
    const messagesLoadedRef = useRef(false)
    // Track current messages for comparison
    const messagesLengthRef = useRef(0)

    // Get messages reactively via ref tracking (to avoid infinite re-renders)
    const [messages, setLocalMessages] = useState<ThreadMessage[]>(() =>
      getMessages(thread.id)
    )

    // Fetch messages if not loaded yet. Only the project page shows a message
    // preview; the sidebar never loads transcripts just to render a row.
    useEffect(() => {
      if (!currentProjectId) return
      const currentMessages = getMessages(thread.id)

      // Initial load: no messages yet, fetch them
      if (currentMessages.length === 0 && !messagesLoadedRef.current) {
        messagesLoadedRef.current = true
        serviceHub
          .messages()
          .fetchMessages(thread.id)
          .then((fetchedMessages) => {
            // Only overwrite if the disk actually has content. A brand-new
            // thread starts empty on disk, and racing this against the
            // optimistic addMessage write was wiping the user message.
            if (fetchedMessages && fetchedMessages.length > 0) {
              setMessages(thread.id, fetchedMessages)
              setLocalMessages(fetchedMessages)
              messagesLengthRef.current = fetchedMessages.length
            }
          })
          .catch(() => {
            messagesLoadedRef.current = false
          })
        return
      }

      // Only update local state if messages length changed (prevents re-renders during streaming)
      if (currentMessages.length !== messagesLengthRef.current) {
        setLocalMessages(currentMessages)
        messagesLengthRef.current = currentMessages.length
      }
    }, [thread.id, currentProjectId, serviceHub, getMessages, setMessages])

    const lastUserMessageText = useMemo(() => {
      const userMessages = messages.filter((m) => m.role === 'user')
      const lastUserMessage = userMessages[userMessages.length - 1]
      if (!lastUserMessage) return undefined
      const textContent = lastUserMessage.content?.find((c) => c.type === 'text')
      return textContent?.text?.value
    }, [messages])

    const plainTitleForRename = useMemo(() => {
      return (thread.title || '').replace(/<span[^>]*>|<\/span>/g, '')
    }, [thread.title])

    // Every group, by name; the thread's own group is ticked rather than hidden.
    const groupChoices = useMemo(
      () => [...folders].sort((a, b) => a.name.localeCompare(b.name)),
      [folders]
    )
    const currentGroupId = thread.metadata?.project?.id ?? null
    const [newGroupOpen, setNewGroupOpen] = useState(false)
    const [previewOpen, setPreviewOpen] = useState(false)

    /** Move the thread into a group, or out of every group with `null`. */
    const moveToGroup = (groupId: string | null) => {
      if (groupId === currentGroupId) return
      const name = groupId ? getFolderById(groupId)?.name : null
      // Home groups are the source of truth; the mirror updates metadata.project.
      void useConversationGroups
        .getState()
        .moveItem('home', thread.id, groupId)
        .then((ok) => {
          if (!ok) return
          toast.success(
            name
              ? t('common:projects.movedToGroup', { name })
              : t('common:projects.movedToUngrouped')
          )
        })
    }

    const [groupMenuOpen, setGroupMenuOpen] = useState(false)

    /**
     * Numbered like the design's group picker: while "Move to group" is open,
     * a digit picks the row with that number. Wired on both menu levels, since
     * opening the submenu with a click leaves focus on its trigger.
     */
    const pickGroupByDigit = (e: React.KeyboardEvent) => {
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1) return
      const choices: (string | null)[] = [...groupChoices.map((g) => g.id), null, 'new']
      if (n > choices.length) return
      const pick = choices[n - 1]
      e.preventDefault()
      if (pick === 'new') setNewGroupOpen(true)
      else moveToGroup(pick)
      setMenuOpen(false)
    }

    const createGroupAndMove = async (name: string, assistantId?: string) => {
      const created = await addFolder(name, assistantId)
      setNewGroupOpen(false)
      await useConversationGroups.getState().moveItem('home', thread.id, created.id)
      toast.success(t('common:projects.movedToGroup', { name: created.name }))
    }

    const isAppStateActive = useIsThreadActive(thread.id)
    const isSessionStreaming = useChatSessions(
      (state) => state.sessions[thread.id]?.isStreaming ?? false
    )
    const toggleFavorite = useThreads((state) => state.toggleFavorite)

    const currentThreadId = useParams({
      strict: false,
      select: (params) => params.threadId,
    })
    const isSelected = currentThreadId === thread.id
    const awaitingApproval = useToolApprovalRequests((s) =>
      Object.values(s.pending ?? {}).some((p) => p.threadId === thread.id)
    )
    const status = useThreadStatus(
      thread,
      isAppStateActive || isSessionStreaming,
      awaitingApproval,
      { id: thread.id, selected: isSelected }
    )

    /**
     * Open the row's menu from somewhere other than its button.
     *
     * Deliberately the same `DropdownMenu` instance rather than a parallel
     * context-menu tree: one definition, so an action added to the button is
     * an action you get on right-click for free.
     */
    const openRowMenu = (e: React.MouseEvent | React.KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setMenuOpen(true)
    }

    const onRowKeyDown = (e: React.KeyboardEvent) => {
      // The two conventional ways to ask for a context menu from the keyboard.
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        openRowMenu(e)
      }
    }

    return (
      <NavItem
        ref={draggable ? drag.setNodeRef : undefined}
        {...(draggable ? drag.listeners : {})}
        onContextMenu={openRowMenu}
        onKeyDown={onRowKeyDown}
        className={cn(
          currentProjectId && 'list-none [&:last-child>a]:border-b-0',
          drag.isDragging && 'opacity-40'
        )}
      >
        {currentProjectId ?
          // A collection page row (the design's `.lrow`): a tile, the title
          // over the last thing asked, and when it was last active.
          <Link
            to="/threads/$threadId"
            params={{ threadId: thread.id }}
            className="group/lrow relative flex max-w-full items-center gap-3 overflow-hidden border-b border-dashed border-border px-0.5 py-3 pr-10 text-[13px] text-foreground outline-hidden transition-colors duration-150 hover:bg-hover-row focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:min-h-11"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg border-[0.8px] border-input bg-card transition-[transform,box-shadow] duration-200 ease-expo group-hover/lrow:-translate-y-px group-hover/lrow:shadow-lift">
              <Icon name="comment" size={16} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="flex min-w-0 items-center gap-1.5">
                {status !== 'none' && <ThreadStatusMark status={status} />}
                <b className="block truncate leading-tight font-medium" title={thread.title || t('common:newThread')}>
                  {thread.title || t('common:newThread')}
                </b>
              </span>
              {lastUserMessageText && (
                <small className="line-clamp-1 text-xs leading-snug text-muted-foreground">
                  {lastUserMessageText}
                </small>
              )}
            </span>
            {thread.updated ? (
              <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
                {formatRowTime(updatedMs(thread.updated))}
              </span>
            ) : null}
          </Link>
          :
          <HoverCard
            openDelay={650}
            closeDelay={80}
            // Shut while the row's menu is open; it used to open over the menu
            // and hide its submenus.
            open={previewOpen && !menuOpen}
            onOpenChange={setPreviewOpen}
          >
            <HoverCardTrigger asChild>
              <NavButton asChild size="sm" isActive={isSelected}>
                <Link to="/threads/$threadId" params={{ threadId: thread.id }} data-testid="thread-nav-item">
                  <ThreadStatusMark status={status} />
                  <span className={cn("block truncate", isSelected && "font-medium")}>{thread.title || t('common:newThread')}</span>
                </Link>
              </NavButton>
            </HoverCardTrigger>
            {/* A peek at the chat without opening it: its title, when it was
                last active and the last thing asked. */}
            <HoverCardContent side="right" align="start" sideOffset={10} className="w-72 p-3">
              <p className="line-clamp-2 text-[0.8125rem] font-medium text-foreground">
                {thread.title || t('common:newThread')}
              </p>
              <p className="mt-1 text-[11px] text-subtle-foreground">
                {thread.updated ? new Date(updatedMs(thread.updated)).toLocaleString() : ''}
              </p>
              {lastUserMessageText && (
                <p className="mt-2 line-clamp-4 rounded-lg bg-muted px-2.5 py-2 text-xs leading-relaxed text-secondary-foreground">
                  {lastUserMessageText}
                </p>
              )}
            </HoverCardContent>
          </HoverCard>
        }
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            {/* Hover reveals it with a mouse; a touch screen has no hover, so
                the row menu stays visible there with a 44px target. */}
            <NavAction
              showOnHover
              className={cn(
                'pointer-coarse:size-9',
                currentProjectId && 'top-1/2 right-1 -translate-y-1/2 opacity-100'
              )}
            >
              <MoreHorizontal />
              <span className="sr-only">{t('common:more')}</span>
            </NavAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-48"
            side={isMobile ? 'bottom' : 'right'}
            align={isMobile ? 'end' : 'start'}
            onKeyDown={(e) => {
              if (groupMenuOpen) pickGroupByDigit(e)
            }}
          >
            <DropdownMenuItem onSelect={() => toggleFavorite(thread.id)}>
              {thread.isFavorite ? <PinOff className="size-4" /> : <Pin className="size-4" />}
              <span>{thread.isFavorite ? t('common:shell.unpin') : t('common:shell.pin')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
              <Pencil className="size-4" />
              <span>{t('common:rename')}</span>
            </DropdownMenuItem>
            <DropdownMenuSub open={groupMenuOpen} onOpenChange={setGroupMenuOpen}>
              <DropdownMenuSubTrigger className="gap-2">
                <Folder className="size-4" />
                <span>{t('common:projects.moveToGroup')}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                className="max-h-72 min-w-48 overflow-y-auto"
                onKeyDown={pickGroupByDigit}
              >
                {groupChoices.map((group, i) => (
                  <DropdownMenuItem
                    key={group.id}
                    onSelect={() => moveToGroup(group.id)}
                    data-testid="move-to-group-option"
                  >
                    <span className="max-w-[200px] truncate">{group.name}</span>
                    {group.id === currentGroupId && (
                      <Check aria-label={t('common:projects.currentGroup')} className="ml-auto size-4 text-info" />
                    )}
                    <DropdownMenuShortcut className={group.id === currentGroupId ? 'ml-2' : undefined}>
                      {i + 1}
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                ))}
                {groupChoices.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={() => moveToGroup(null)}>
                  <span>{t('common:shell.ungrouped')}</span>
                  {currentGroupId === null && (
                    <Check aria-label={t('common:projects.currentGroup')} className="ml-auto size-4 text-info" />
                  )}
                  <DropdownMenuShortcut className={currentGroupId === null ? 'ml-2' : undefined}>
                    {groupChoices.length + 1}
                  </DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setNewGroupOpen(true)}>
                  <span>
                    {groupChoices.length === 0
                      ? t('common:projects.createFirstGroup')
                      : t('common:projects.newGroup')}
                  </span>
                  <DropdownMenuShortcut>{groupChoices.length + 2}</DropdownMenuShortcut>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                void navigator.clipboard?.writeText(thread.id)
                toast.success(t('common:copiedConversationId'))
              }}
            >
              <Copy className="size-4" />
              <span>{t('common:copyConversationId')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={thread.title === 'What is Jan?' && !localStorage.getItem('setup-completed')}
              onSelect={() => {
                if (thread.title !== 'What is Jan?' || localStorage.getItem('setup-completed')) {
                  setDeleteConfirmOpen(true)
                }
              }}
            >
              <Trash2 className="size-4" />
              <span>{t('common:delete')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Mounted only while open: one per chat row would be wasted. */}
        {newGroupOpen && (
          <AddProjectDialog
            open
            onOpenChange={setNewGroupOpen}
            editingKey={null}
            noun="group"
            onSave={createGroupAndMove}
          />
        )}

        <RenameThreadDialog
          thread={thread}
          plainTitleForRename={plainTitleForRename}
          onRename={renameThread}
          open={renameOpen}
          onOpenChange={setRenameOpen}
          withoutTrigger
        />
        
        <DeleteThreadDialog
          thread={thread}
          onDelete={deleteThread}
          open={deleteConfirmOpen}
          onOpenChange={setDeleteConfirmOpen}
          withoutTrigger
        />
      </NavItem>
    )
  }
)

/** "10:18" today, "Yesterday", a weekday this week, else the date. */
function formatRowTime(ms: number, now = new Date()): string {
  const d = new Date(ms)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(now) - day(d)) / 86_400_000)
  if (days <= 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  }
  if (days === 1) {
    return new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: 'auto' }).format(-1, 'day')
  }
  if (days < 7) return d.toLocaleDateString(document.documentElement.lang || [], { weekday: 'short' })
  return d.toLocaleDateString(document.documentElement.lang || [], { month: 'short', day: 'numeric' })
}

type ThreadListProps = {
  threads: Thread[]
  currentProjectId?: string
  /** Rows can be dragged onto a chat group (needs a DndContext above). */
  draggable?: boolean
}

function ThreadList({ threads, currentProjectId, draggable }: ThreadListProps) {
  const { isMobile } = useShellNav()

  const sortedThreads = useMemo(() => {
    return [...threads].sort((a, b) => {
      return (b.updated || 0) - (a.updated || 0)
    })
  }, [threads])

  return (
    <>
      {sortedThreads.map((thread) => (
        <ThreadItem
          key={thread.id}
          thread={thread}
          isMobile={isMobile}
          currentProjectId={currentProjectId}
          draggable={draggable}
        />
      ))}
    </>
  )
}

export { ThreadItem }
export default memo(ThreadList)
