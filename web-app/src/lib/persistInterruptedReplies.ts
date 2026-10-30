import type { UIMessage } from 'ai'
import type { ThreadMessage } from '@janhq/core'
import { useChatSessions, isSessionBusy } from '@/stores/chat-session-store'
import { useMessages } from '@/hooks/useMessages'
import { useThreads } from '@/hooks/useThreads'
import { getServiceHub } from '@/hooks/useServiceHub'
import { cancelPendingMessageWrites } from '@/lib/messageWriteQueue'
import { uiMessageHasMeaningfulContent } from '@/lib/messages'
import { getParentId, planContinuation } from '@/lib/message-branching'
import {
  buildAssistantThreadMessage,
  resolveAssistantParentIn,
} from '@/lib/assistantReply'
import { redactText } from '@/lib/redactToolOutput'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

/** Error text saved on a tool call the app closed before it returned. */
export const INTERRUPTED_TOOL_ERROR = 'interrupted by app exit'

/** The Rust close handler waits 2.5 s for the flush; leave it room. */
export const INTERRUPTED_PERSIST_CAP_MS = 1500

export type ReplyContext = {
  /** The stopped reply this one continues (it replaces that partial). */
  continueReplaceId: string | null
  /** The user turn this reply answers. */
  parentId: string | null
}

const contexts = new Map<string, () => ReplyContext>()
const persisted = new Set<string>()

/** The open chat view tells the quit path how its reply links in. */
export const registerReplyContext = (
  threadId: string,
  get: () => ReplyContext
): (() => void) => {
  contexts.set(threadId, get)
  return () => {
    if (contexts.get(threadId) === get) contexts.delete(threadId)
  }
}

/** This reply was saved on quit: a late onFinish must not save it again. */
export const wasPersistedOnQuit = (messageId: string): boolean =>
  persisted.has(messageId)

/** Test helper. */
export const resetInterruptedReplies = () => {
  contexts.clear()
  persisted.clear()
}

const isToolPart = (p: { type?: unknown }) =>
  typeof p.type === 'string' && p.type.startsWith('tool-')

/**
 * Tool calls still running become errors (they are never re-run); outputs
 * already in are redacted again before they reach the transcript.
 */
async function settleToolParts(message: UIMessage): Promise<UIMessage> {
  const parts = await Promise.all(
    (message.parts as Array<Record<string, unknown>>).map(async (p) => {
      if (!isToolPart(p)) return p
      if (p.state === 'output-error' || p.state === 'output-denied') return p
      const output = p.output ?? p.result
      if (output === undefined) {
        return {
          ...p,
          state: 'output-error',
          errorText: INTERRUPTED_TOOL_ERROR,
        }
      }
      if (typeof output === 'string') {
        return { ...p, output: await redactText(output) }
      }
      return p
    })
  )
  return { ...message, parts } as UIMessage
}

async function persistOne(threadId: string, chatMessages: UIMessage[]) {
  const last = chatMessages[chatMessages.length - 1]
  if (!last || last.role !== 'assistant') return
  if (!uiMessageHasMeaningfulContent(last)) return
  if (persisted.has(last.id)) return

  const message = await settleToolParts(last)
  const saved = useMessages.getState().getMessages(threadId)
  const ctx = contexts.get(threadId)?.()
  const activeRootId = (
    useThreads.getState().threads[threadId]?.metadata as
      | Record<string, unknown>
      | undefined
  )?.activeRootId as string | undefined
  const continuation = planContinuation(
    saved,
    message.id,
    ctx?.continueReplaceId,
    ctx?.parentId ?? resolveAssistantParentIn(saved, activeRootId, undefined)
  )
  const existing = saved.find((m) => m.id === message.id)
  const parentId =
    (existing ? getParentId(existing) : null) ?? continuation.parentId

  const built = buildAssistantThreadMessage({
    message,
    threadId,
    existing,
    metadata: {
      ...((message.metadata || {}) as Record<string, unknown>),
      stopped: true,
      interrupted: 'quit',
    },
    parentId,
  })

  persisted.add(message.id)
  const messages = getServiceHub().messages()
  let written: ThreadMessage
  if (existing) {
    // A queued older write must not land over this one.
    cancelPendingMessageWrites(threadId, message.id)
    written = (await messages.modifyMessage(built)) ?? built
  } else {
    written = (await messages.createMessage(built)) ?? built
  }
  if (continuation.deletePartialId) {
    cancelPendingMessageWrites(threadId, continuation.deletePartialId)
    await messages.deleteMessage(threadId, continuation.deletePartialId)
  }

  useMessages.setState((state) => {
    const list = (state.messages[threadId] ?? []).filter(
      (m) => m.id !== continuation.deletePartialId
    )
    const next = list.some((m) => m.id === written.id)
      ? list.map((m) => (m.id === written.id ? written : m))
      : [...list, written]
    return { messages: { ...state.messages, [threadId]: next } }
  })
}

/**
 * The app is closing: save every reply still streaming as a stopped,
 * interrupted message, once. Waits at most `capMs`, then stops the chats so a
 * late onFinish cannot save the reply a second time. Never rejects.
 */
export async function persistInterruptedReplies(
  capMs = INTERRUPTED_PERSIST_CAP_MS
): Promise<void> {
  const sessions = Object.entries(useChatSessions.getState().sessions).filter(
    ([threadId, session]) =>
      threadId !== TEMPORARY_CHAT_ID &&
      isSessionBusy(session) &&
      !!useThreads.getState().threads[threadId]
  )
  if (sessions.length === 0) return

  const work = Promise.all(
    sessions.map(([threadId, session]) =>
      persistOne(threadId, session.chat.messages).catch((e) =>
        console.error(`saving interrupted reply in ${threadId} failed:`, e)
      )
    )
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, capMs)
    }),
  ])
  clearTimeout(timer)

  for (const [, session] of sessions) {
    try {
      session.chat.stop()
    } catch (e) {
      console.error('Failed to stop chat session', e)
    }
  }
}
