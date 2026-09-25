import { createFileRoute, useParams, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useRef } from 'react'
import { cn } from '@/lib/utils'

import HeaderPage from '@/containers/HeaderPage'
import { ThreadConversation } from '@/containers/ThreadConversation'
import {
  CloseSplitButton,
  SecondaryPaneControls,
  SecondaryPanePicker,
  SplitDivider,
  SplitPaneSwitch,
  SplitToggleButton,
} from '@/containers/SplitConversation'
import {
  ConversationPaneContext,
  type ConversationPane,
} from '@/hooks/useConversationPane'
import {
  SPLIT_SIDE_BY_SIDE_QUERY,
  useSplitConversation,
  type SplitPaneId,
} from '@/hooks/useSplitConversation'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useThreads } from '@/hooks/useThreads'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

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
 * A Chat conversation, or two side by side.
 *
 * The route names the main pane's thread. When the conversation is split, a
 * second, fully independent conversation sits beside it: each pane renders
 * its own `ThreadConversation` with its own thread id, so session, stream,
 * model, draft, attachments, approvals and scroll never cross. At 1100px and
 * wider the panes share the width over a resizable divider; below that they
 * take turns, with a switch that says which one is showing and whether the
 * other is replying. Both stay mounted either way, so switching panes or
 * crossing the breakpoint loses no draft, stream or scroll position.
 */
function ThreadDetail() {
  const { threadId } = useParams({ from: Route.id })
  const search = useSearch({ from: Route.id })
  const { t } = useTranslation()

  const open = useSplitConversation((s) => s.open)
  const storedSecondary = useSplitConversation((s) => s.secondaryThreadId)
  const activePane = useSplitConversation((s) => s.activePane)
  const ratio = useSplitConversation((s) => s.ratio)
  const setActivePane = useSplitConversation((s) => s.setActivePane)
  const secondaryExists = useThreads((s) =>
    Boolean(storedSecondary && s.threads?.[storedSecondary])
  )
  const sideBySide = useMediaQuery(SPLIT_SIDE_BY_SIDE_QUERY)
  const panesRef = useRef<HTMLDivElement>(null)

  // Never the same thread in both panes: two views of one session would run
  // its tool loop twice. A temporary chat stays a single conversation.
  const secondaryThreadId =
    open &&
    storedSecondary &&
    secondaryExists &&
    storedSecondary !== threadId &&
    storedSecondary !== TEMPORARY_CHAT_ID
      ? storedSecondary
      : undefined

  // Opening the second pane's conversation in the main one (from the
  // sidebar) swaps them, so both stay open; any navigation is work in the
  // main pane.
  const previousPrimary = useRef(threadId)
  useEffect(() => {
    const previous = previousPrimary.current
    previousPrimary.current = threadId
    if (!open || previous === threadId) return
    const state = useSplitConversation.getState()
    if (state.secondaryThreadId === threadId) {
      state.setSecondaryThread(previous)
    }
    state.setActivePane('primary')
  }, [threadId, open])

  const primaryPane = useMemo<ConversationPane>(
    () => ({
      paneId: 'primary',
      threadId,
      isSplit: open,
      // With no second conversation chosen yet, the main one is still the
      // one being worked in.
      isActive: !open || activePane === 'primary' || !secondaryThreadId,
    }),
    [threadId, open, activePane, secondaryThreadId]
  )
  const secondaryPane = useMemo<ConversationPane | null>(
    () =>
      secondaryThreadId
        ? {
            paneId: 'secondary',
            threadId: secondaryThreadId,
            isSplit: true,
            isActive: activePane === 'secondary',
          }
        : null,
    [secondaryThreadId, activePane]
  )

  // Working in a pane -- a click, a tap, a focus from the keyboard -- makes
  // it the active one.
  const activate = (pane: SplitPaneId) => () => {
    if (open) setActivePane(pane)
  }

  const primaryVisible = !open || sideBySide || activePane === 'primary'
  const secondaryVisible = open && (sideBySide || activePane === 'secondary')

  return (
    <div className="flex h-full min-h-0 flex-col">
      {open && (
        <HeaderPage>
          <div className="flex w-full min-w-0 items-center justify-between gap-2 md:pr-1">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {sideBySide ? (
                <h1 className="truncate text-sm font-medium text-secondary-foreground">
                  {t('chat:split.label')}
                </h1>
              ) : (
                <SplitPaneSwitch
                  primaryThreadId={threadId}
                  secondaryThreadId={secondaryThreadId}
                />
              )}
            </div>
            <CloseSplitButton />
          </div>
        </HeaderPage>
      )}
      <div
        ref={panesRef}
        data-testid="conversation-panes"
        data-split={open}
        className={cn(
          'relative flex min-h-0 min-w-0 flex-1',
          // Split panes are Frames of their own: give them the page's room.
          open && 'px-1 pt-3.5 pb-4'
        )}
      >
        <div
          id="conversation-pane-primary"
          data-testid="conversation-pane-primary"
          data-active={primaryPane.isActive}
          role={open && !sideBySide ? 'tabpanel' : undefined}
          aria-hidden={primaryVisible ? undefined : true}
          inert={!primaryVisible}
          onFocusCapture={activate('primary')}
          onPointerDownCapture={activate('primary')}
          style={open && sideBySide ? { width: `${ratio * 100}%` } : undefined}
          className={cn(
            'min-h-0 min-w-0',
            !open && 'relative flex-1',
            open && sideBySide && 'relative shrink-0',
            open && !sideBySide && 'absolute inset-0',
            !primaryVisible && 'invisible'
          )}
        >
          <ConversationPaneContext.Provider value={primaryPane}>
            <ThreadConversation
              threadId={threadId}
              searchThreadModel={search.threadModel}
              contextControls={<SplitToggleButton />}
            />
          </ConversationPaneContext.Provider>
        </div>
        {open && sideBySide && <SplitDivider containerRef={panesRef} />}
        {open && (
          <div
            id="conversation-pane-secondary"
            data-testid="conversation-pane-secondary"
            data-active={secondaryPane?.isActive ?? activePane === 'secondary'}
            role={!sideBySide ? 'tabpanel' : undefined}
            aria-hidden={secondaryVisible ? undefined : true}
            inert={!secondaryVisible}
            onFocusCapture={activate('secondary')}
            onPointerDownCapture={activate('secondary')}
            className={cn(
              'min-h-0 min-w-0',
              sideBySide ? 'relative flex-1' : 'absolute inset-0',
              !secondaryVisible && 'invisible'
            )}
          >
            {secondaryPane ? (
              <ConversationPaneContext.Provider value={secondaryPane}>
                <ThreadConversation
                  // A different conversation in this pane is a fresh one.
                  key={secondaryPane.threadId}
                  threadId={secondaryPane.threadId}
                  paneControls={<SecondaryPaneControls />}
                />
              </ConversationPaneContext.Provider>
            ) : (
              <SecondaryPanePicker primaryThreadId={threadId} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
