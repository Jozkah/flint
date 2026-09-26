import type { UIMessage } from 'ai'
import { useThreads } from '@/hooks/useThreads'
import { summaryMessage, type CompactionRecord } from '@/lib/compaction'

/**
 * Chat's compaction in force, kept with the thread (`thread.metadata.compaction`)
 * so a restart reuses the summary instead of writing it again.
 *
 * Chat sends the whole stored conversation on every request; the summary
 * stands in for everything before `boundaryId`, the first message it did not
 * fold.
 */
export type ChatCompactionState = {
  record: CompactionRecord
  boundaryId: string
  latestRequest: string | null
}

/** Threads with no stored record (a temporary chat that is not saved). */
const unsaved = new Map<string, ChatCompactionState>()

function valid(value: unknown): ChatCompactionState | null {
  const v = value as Partial<ChatCompactionState> | null | undefined
  if (
    !v ||
    typeof v.boundaryId !== 'string' ||
    !v.record ||
    typeof v.record.summary !== 'string' ||
    typeof v.record.summarizedCount !== 'number'
  ) {
    return null
  }
  return {
    record: v.record,
    boundaryId: v.boundaryId,
    latestRequest: typeof v.latestRequest === 'string' ? v.latestRequest : null,
  }
}

export function readChatCompaction(threadId: string): ChatCompactionState | null {
  const thread = useThreads.getState().threads[threadId]
  if (!thread) return unsaved.get(threadId) ?? null
  return valid(thread.metadata?.compaction)
}

export function writeChatCompaction(
  threadId: string,
  state: ChatCompactionState | null
): void {
  const store = useThreads.getState()
  const thread = store.threads[threadId]
  if (!thread) {
    if (state) unsaved.set(threadId, state)
    else unsaved.delete(threadId)
    return
  }
  const metadata = { ...(thread.metadata ?? {}) }
  if (state) metadata.compaction = state
  else delete metadata.compaction
  store.updateThread(threadId, { metadata })
}

/**
 * The history a request sends with the compaction in force applied. `stale`
 * when the boundary message is gone (edited or deleted): the summary no longer
 * describes what precedes it and should be forgotten.
 */
export function applyChatCompaction(
  messages: UIMessage[],
  state: ChatCompactionState | null
): { history: UIMessage[]; stale: boolean } {
  if (!state) return { history: messages, stale: false }
  const at = messages.findIndex((m) => m.id === state.boundaryId)
  if (at < 0) return { history: messages, stale: true }
  if (at === 0) return { history: messages, stale: false }
  return {
    history: [
      ...messages.slice(0, at).filter((m) => m.role === 'system'),
      summaryMessage(state.record, state.latestRequest),
      ...messages.slice(at),
    ],
    stale: false,
  }
}

/** The state to keep after a compaction produced `messages`. */
export function stateAfter(
  messages: UIMessage[],
  record: CompactionRecord,
  latestRequest: string | null
): ChatCompactionState | null {
  const at = messages.findIndex(
    (m) => (m.metadata as { compaction?: unknown } | undefined)?.compaction
  )
  const boundary = at >= 0 ? messages[at + 1] : undefined
  return boundary ? { record, boundaryId: boundary.id, latestRequest } : null
}

/**
 * Manual compaction from the composer (`/compact`): the open conversation
 * registers how to compact itself, and the composer asks by thread id.
 */
type Compactor = () => Promise<void>
const compactors = new Map<string, Compactor>()

export function registerChatCompactor(threadId: string, fn: Compactor): () => void {
  compactors.set(threadId, fn)
  return () => {
    if (compactors.get(threadId) === fn) compactors.delete(threadId)
  }
}

export function requestChatCompaction(threadId: string): boolean {
  const fn = compactors.get(threadId)
  if (!fn) return false
  void fn()
  return true
}
