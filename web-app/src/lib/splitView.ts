import { toast } from 'sonner'
import { route } from '@/constants/routes'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import {
  useSplitConversation,
  type AddPaneResult,
  type SplitTarget,
} from '@/hooks/useSplitConversation'

/**
 * Opening conversations in split view from outside the panes: a row's menu,
 * the keyboard shortcut, a header button.
 *
 * Split view lives on the two routes that show a conversation -- a Chat
 * thread and Cowork -- where the route's conversation is the main pane. From
 * anywhere else, the conversation asked for opens as the main one first.
 */

type Navigate = (to: {
  to: string
  params?: Record<string, string>
}) => unknown

let navigator: Navigate | null = null

/** Registered once by the app shell, which owns the router. */
export function registerSplitNavigator(fn: Navigate | null) {
  navigator = fn
}

const threadPath = /^\/threads\/([^/]+)\/?$/

/** The conversation the route shows, if the route shows one. */
export function currentPrimary(
  pathname: string = typeof window === 'undefined'
    ? ''
    : window.location.pathname
): SplitTarget | null {
  const thread = threadPath.exec(pathname)
  if (thread) return { kind: 'chat', refId: decodeURIComponent(thread[1]) }
  if (pathname === route.cowork || pathname === `${route.cowork}/`) {
    return {
      kind: 'cowork',
      refId: useCoworkSessions.getState().currentId ?? undefined,
    }
  }
  return null
}

/** Show `target` as the route's own conversation. */
export function openAsPrimary(target: SplitTarget) {
  if (!target.refId || !navigator) return
  if (target.kind === 'chat') {
    navigator({
      to: route.threadsDetail,
      params: { threadId: target.refId },
    })
  } else {
    useCoworkSessions.getState().selectSession(target.refId)
    navigator({ to: route.cowork })
  }
}

export type SplitOpenResult = AddPaneResult | 'primary' | 'unavailable'

/** "Open in split view" on a conversation. */
export function openInSplit(target: SplitTarget): SplitOpenResult {
  const split = useSplitConversation.getState()
  const primary = currentPrimary()
  if (!primary) {
    // Nothing on screen to split with: open it, with an empty pane beside.
    if (!navigator) return 'unavailable'
    openAsPrimary(target)
    if (split.panes.length === 0) split.addPane()
    return 'primary'
  }
  if (primary.kind === target.kind && primary.refId === target.refId) {
    split.setActivePane('primary')
    return split.panes.length === 0 ? split.addPane() : 'shown'
  }
  return split.addPane(target)
}

/** Split the conversation on screen: an empty pane opens beside it. */
export function splitCurrent(): SplitOpenResult {
  if (!currentPrimary()) return 'unavailable'
  return useSplitConversation.getState().addPane()
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/** Says why nothing opened, when nothing did. */
export function reportSplitResult(result: SplitOpenResult, t: Translate) {
  if (result === 'full') {
    toast.error(
      t('chat:split.full', {
        count: useSplitConversation.getState().maxPanes,
      })
    )
  } else if (result === 'unavailable') {
    toast.error(t('chat:split.unavailable'))
  }
}
