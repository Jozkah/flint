import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, MoreHorizontal } from 'lucide-react'
import { useParams } from '@tanstack/react-router'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SidebarGroupAction, useSidebar } from '@/components/ui/sidebar'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useThreads } from '@/hooks/useThreads'
import { useAppState } from '@/hooks/useAppState'
import { useChatSessions } from '@/stores/chat-session-store'
import { ThreadItem } from '@/containers/ThreadList'
import { DeleteAllThreadsDialog } from '@/containers/dialogs/DeleteAllThreadsDialog'
import { GroupedNav, type GroupRowProps } from '@/components/groups/GroupedNav'
import { startHomeProjectsMirror } from '@/lib/groups/homeMirror'
import { ID_SEP, useActiveIdSet } from '@/lib/groups/useActiveIdSet'

const threadId = (t: Thread) => t.id
const threadLabel = (t: Thread) => (t.title || 'New Thread').replace(/<[^>]+>/g, '')

/** Home chats: groups (formerly projects) above Recents. */
export function NavHomeGroups() {
  const { t } = useTranslation()
  const { isMobile } = useSidebar()
  const threadsMap = useThreads((s) => s.threads)
  const isLoadingThreads = useThreads((s) => s.isLoadingThreads)
  const deleteAllThreads = useThreads((s) => s.deleteAllThreads)
  const [menuOpen, setMenuOpen] = useState(false)
  const selectedId = useParams({ strict: false, select: (p) => p.threadId as string | undefined })

  useEffect(() => startHomeProjectsMirror(), [])

  // Recent-activity order, as the chat list always used.
  const threads = useMemo(
    () =>
      Object.values(threadsMap)
        .filter((th) => !th.metadata?.isTemporary)
        .sort((a, b) => (b.updated || 0) - (a.updated || 0)),
    [threadsMap]
  )

  const appActive = useAppState((s) =>
    [
      ...Object.keys(s.streamingContents),
      ...Object.keys(s.loadingModels),
      ...Object.keys(s.cancelToolCalls),
      ...Object.keys(s.busyThreads),
    ].join(ID_SEP)
  )
  const streaming = useChatSessions((s) =>
    Object.entries(s.sessions)
      .filter(([, v]) => v?.isStreaming)
      .map(([k]) => k)
      .join(ID_SEP)
  )
  const activeIds = useActiveIdSet(appActive, streaming)

  const renderItem = useCallback(
    (thread: Thread, row: GroupRowProps) => (
      <ThreadItem key={thread.id} thread={thread} isMobile={isMobile} row={row} />
    ),
    [isMobile]
  )

  return (
    <GroupedNav<Thread>
      surface="home"
      items={threads}
      getId={threadId}
      getLabel={threadLabel}
      activeIds={activeIds}
      selectedId={selectedId}
      renderItem={renderItem}
      recentsLabel={t('common:recents')}
      emptyRecents={
        isLoadingThreads ? (
          <div className="flex items-center justify-center py-2">
            <Loader2 className="size-4 motion-safe:animate-spin text-muted-foreground" />
          </div>
        ) : null
      }
      recentsAction={
        threads.length > 1 ? (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <SidebarGroupAction className="hover:bg-sunken pointer-coarse:size-9">
                <MoreHorizontal className="text-muted-foreground" />
                <span className="sr-only">More</span>
              </SidebarGroupAction>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start">
              <DeleteAllThreadsDialog onDeleteAll={deleteAllThreads} onDropdownClose={() => setMenuOpen(false)} />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined
      }
    />
  )
}
