import { ThreadMessage } from '@janhq/core'
import { toast } from 'sonner'
import { getServiceHub } from '@/hooks/useServiceHub'
import { i18n } from '@/i18n/react-i18next-compat'
import { registerExitFlusher } from '@/lib/deferredPersistStorage'

/**
 * Message updates (streaming, metadata) arrive in bursts and each backend
 * write rewrites the thread's whole file (PERF-010). The store updates at
 * once; the write waits this long per message and only the latest value is
 * written.
 */
export const MESSAGE_PERSIST_DELAY_MS = 300

type PendingWrite = {
  message: ThreadMessage
  timer: ReturnType<typeof setTimeout>
}

const pendingWrites = new Map<string, PendingWrite>()
const writeKey = (threadId: string, messageId: string) =>
  `${threadId}:${messageId}`

const persistUpdate = (message: ThreadMessage): Promise<void> =>
  new Promise<unknown>((resolve) =>
    resolve(getServiceHub().messages().modifyMessage(message))
  ).then(
    () => undefined,
    (error) => {
      console.error('Failed to persist message update:', error)
      toast.error(i18n.t('common:messageSaveFailed'))
    }
  )

const takePending = (
  match: (message: ThreadMessage) => boolean
): ThreadMessage[] => {
  const taken: ThreadMessage[] = []
  for (const [key, pending] of pendingWrites) {
    if (!match(pending.message)) continue
    clearTimeout(pending.timer)
    pendingWrites.delete(key)
    taken.push(pending.message)
  }
  return taken
}

/** Write pending message updates now (all, or one thread's). Never rejects. */
export const flushPendingMessageWrites = async (
  threadId?: string
): Promise<void> => {
  const due = takePending((m) => threadId === undefined || m.thread_id === threadId)
  await Promise.all(due.map(persistUpdate))
}

/**
 * Drop pending writes for a thread (or one message of it) that is being
 * deleted, so a late write cannot bring it back.
 */
export const cancelPendingMessageWrites = (
  threadId: string,
  messageId?: string
): void => {
  takePending(
    (m) =>
      m.thread_id === threadId && (messageId === undefined || m.id === messageId)
  )
}

export const schedulePersist = (message: ThreadMessage) => {
  const key = writeKey(message.thread_id, message.id)
  const previous = pendingWrites.get(key)
  if (previous) clearTimeout(previous.timer)
  const timer = setTimeout(() => {
    if (pendingWrites.get(key)?.timer !== timer) return
    pendingWrites.delete(key)
    void persistUpdate(message)
  }, MESSAGE_PERSIST_DELAY_MS)
  pendingWrites.set(key, { message, timer })
}

// Nothing pending is lost when the page goes away or the desktop window closes.
registerExitFlusher(() => flushPendingMessageWrites())
if (typeof window !== 'undefined') {
  const flushAll = () => void flushPendingMessageWrites()
  window.addEventListener('pagehide', flushAll)
  window.addEventListener('beforeunload', flushAll)
}
