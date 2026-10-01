import type { ThreadMessage } from '@janhq/core'
import { useMessages } from '@/hooks/useMessages'
import { useThreads } from '@/hooks/useThreads'
import {
  activeRootAfterRemoval,
  activeRootIdOf,
  getParentId,
  getSiblings,
  withActiveChild,
} from '@/lib/message-branching'

/**
 * Fired on `window` when a version was switched from outside the open chat (the
 * phone), so a chat open on the desktop re-reads the path it shows and sends.
 */
export const BRANCH_CHANGED_EVENT = 'flint:branch-changed'

/**
 * Make `node` the shown version among its siblings: a root is remembered on the
 * thread, anything else on its parent as `activeChildId`.
 */
export function setActiveBranch(threadId: string, node: ThreadMessage): void {
  const parentId = getParentId(node)
  if (!parentId) {
    const thread = useThreads.getState().threads[threadId]
    useThreads.getState().updateThread(threadId, {
      metadata: {
        ...((thread?.metadata as Record<string, unknown> | undefined) ?? {}),
        activeRootId: node.id,
      },
    })
    return
  }
  const parent = useMessages
    .getState()
    .getMessages(threadId)
    .find((m) => m.id === parentId)
  if (parent) useMessages.getState().updateMessage(withActiveChild(parent, node.id))
}

/**
 * Call before removing `removeIds` from a thread: if the thread's selected root
 * is among them, point it at the root that replaces it (or clear it).
 */
export function repairActiveRoot(
  threadId: string,
  messages: ThreadMessage[],
  removeIds: string[]
): void {
  const thread = useThreads.getState().threads[threadId]
  const metadata = (thread?.metadata as Record<string, unknown> | undefined) ?? {}
  const next = activeRootAfterRemoval(messages, removeIds, activeRootIdOf(metadata))
  if (next === undefined) return
  const { activeRootId: _gone, ...rest } = metadata
  void _gone
  useThreads.getState().updateThread(threadId, {
    metadata: next === null ? rest : { ...rest, activeRootId: next },
  })
}

/**
 * Step the version of `messageId` one sibling back (-1) or forward (+1).
 * Returns the message now shown, or null when there is no such message or no
 * sibling in that direction.
 */
export function selectVersion(
  threadId: string,
  messageId: string,
  dir: -1 | 1
): ThreadMessage | null {
  const messages = useMessages.getState().getMessages(threadId)
  const target = messages.find((m) => m.id === messageId)
  if (!target) return null
  const siblings = getSiblings(messages, target)
  const next = siblings[siblings.findIndex((m) => m.id === messageId) + dir]
  if (!next) return null
  setActiveBranch(threadId, next)
  return next
}
