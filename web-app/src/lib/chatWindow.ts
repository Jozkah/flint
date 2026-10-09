import { getServiceHub } from '@/hooks/useServiceHub'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import type { SplitTarget } from '@/hooks/useSplitConversation'

/**
 * "New window" on a conversation: a second app window that shows only that
 * conversation (and, for Cowork, its right rail) -- no left navigation.
 *
 * The window is told what it is by a query flag on its URL, read once at load
 * so in-window navigation, which may drop the query, cannot turn the sidebar
 * back on.
 */

const FLAG = 'chatWindow'
const SESSION = 'session'

export const CHAT_WINDOW_LABEL_PREFIX = 'chat-window-'

const search = typeof window === 'undefined' ? '' : window.location.search
const params = new URLSearchParams(search)
const chatWindow = params.has(FLAG)
const initialSession = params.get(SESSION)

/** True in a window opened by "New window". */
export function isChatWindow(): boolean {
  return chatWindow
}

/** The URL a new window loads for a conversation. */
export function chatWindowUrl(target: SplitTarget): string {
  const ref = target.refId ?? ''
  const q = new URLSearchParams({ [FLAG]: '1' })
  if (target.kind === 'chat') {
    return `/threads/${encodeURIComponent(ref)}?${q}`
  }
  if (target.kind === 'room') {
    return `/rooms/${encodeURIComponent(ref)}?${q}`
  }
  q.set(SESSION, ref)
  return `/cowork?${q}`
}

/** Select the Cowork session a chat window was opened for. Idempotent. */
export function applyChatWindowSession() {
  if (!chatWindow || !initialSession) return
  const store = useCoworkSessions.getState()
  if (store.currentId !== initialSession) store.selectSession(initialSession)
}

export async function openChatWindow(target: SplitTarget): Promise<void> {
  await getServiceHub()
    .window()
    .createWebviewWindow({
      url: chatWindowUrl(target),
      label: `${CHAT_WINDOW_LABEL_PREFIX}${Date.now().toString(36)}`,
      title: 'Flint',
      width: 1100,
      height: 800,
      center: true,
      resizable: true,
    })
}
