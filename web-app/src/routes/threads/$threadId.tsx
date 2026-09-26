import { createFileRoute, useParams, useSearch } from '@tanstack/react-router'
import { useMemo } from 'react'

import { ThreadConversation } from '@/containers/ThreadConversation'
import {
  PaneControls,
  SplitToggleButton,
  SplitWorkspace,
  type PrimaryPaneState,
} from '@/containers/SplitConversation'
import {
  ConversationPaneContext,
  type ConversationPane,
} from '@/hooks/useConversationPane'
import { PRIMARY_PANE, type SplitTarget } from '@/hooks/useSplitConversation'

type ThreadModel = {
  id: string
  provider: string
}

type SearchParams = {
  threadModel?: ThreadModel
}

// as route.threadsDetail
export const Route = createFileRoute('/threads/$threadId')({
  component: ThreadDetail,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    return {
      threadModel: search.threadModel as ThreadModel | undefined,
    }
  },
})

/**
 * A Chat conversation, alone or in split view.
 *
 * The route names the main pane's thread. In split view other conversations
 * -- Chat threads or Cowork sessions -- sit beside it, each fully independent
 * (see `SplitWorkspace`).
 */
function ThreadDetail() {
  const { threadId } = useParams({ from: Route.id })
  const search = useSearch({ from: Route.id })
  const primary = useMemo<SplitTarget>(
    () => ({ kind: 'chat', refId: threadId }),
    [threadId]
  )
  return (
    <SplitWorkspace primary={primary}>
      {(state) => (
        <PrimaryChat
          threadId={threadId}
          threadModel={search.threadModel}
          state={state}
        />
      )}
    </SplitWorkspace>
  )
}

function PrimaryChat({
  threadId,
  threadModel,
  state,
}: {
  threadId: string
  threadModel?: ThreadModel
  state: PrimaryPaneState
}) {
  const pane = useMemo<ConversationPane>(
    () => ({
      paneId: PRIMARY_PANE,
      threadId,
      isSplit: state.isSplit,
      isActive: state.isActive,
    }),
    [threadId, state.isSplit, state.isActive]
  )
  return (
    <ConversationPaneContext.Provider value={pane}>
      <ThreadConversation
        threadId={threadId}
        searchThreadModel={threadModel}
        contextControls={<SplitToggleButton />}
        paneControls={
          state.isSplit ? <PaneControls paneId={PRIMARY_PANE} /> : undefined
        }
      />
    </ConversationPaneContext.Provider>
  )
}
