import { create } from 'zustand'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { useMessages } from '@/hooks/useMessages'
import { useAppState } from '@/hooks/useAppState'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import {
  overridesToCarry,
  persistedEverything,
  readdressMessages,
  titleForKeptChat,
  type PromotionResult,
} from '@/lib/temporaryChat'

/**
 * The lifecycle of a temporary chat: keeping one, and throwing one away.
 *
 * Both operations exist because a temporary chat is never persisted. Keeping
 * is therefore a copy — a new thread, every message written for the first
 * time — and discarding is a sweep of every store keyed by
 * `TEMPORARY_CHAT_ID`, which the *next* temporary chat will reuse.
 *
 * Nothing here promotes on its own. A temporary chat becomes permanent only
 * when the user says so.
 */

/** How long to wait for a cancelled generation to actually stop. */
const CANCEL_TIMEOUT_MS = 5000
const CANCEL_POLL_MS = 50

type TemporaryChatState = {
  /**
   * Bumped every time a temporary chat ends.
   *
   * The id is reused, so a stream that has not noticed its abort could still
   * write into the *next* chat. Anything that might land late captures this
   * and drops its write when it no longer matches.
   */
  epoch: number
  /** A promotion or discard in flight; the dialog disables while it runs. */
  busy: boolean

  /** Is this still the chat the caller started out in? */
  isCurrentEpoch: (epoch: number) => boolean
  /**
   * Copy the temporary chat into a real thread. Nothing is deleted unless
   * every message is confirmed present on the new one.
   */
  keep: () => Promise<PromotionResult>
  /** Throw it away, leaving nothing for the next temporary chat to inherit. */
  discard: () => Promise<{ ok: boolean; reason?: string }>
}

/** Wait for a thread to stop generating, or report that it did not. */
async function waitUntilIdle(threadId: string): Promise<boolean> {
  const deadline = Date.now() + CANCEL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!useAppState.getState().busyThreads[threadId]) return true
    await new Promise((resolve) => setTimeout(resolve, CANCEL_POLL_MS))
  }
  return !useAppState.getState().busyThreads[threadId]
}

/**
 * Stop whatever the temporary chat is doing, through the same path the stop
 * button uses, and wait for it to actually be over.
 *
 * Returns false when it is still running: the caller must then leave the chat
 * alone rather than tear state out from under a live stream.
 */
async function stopGeneration(threadId: string): Promise<boolean> {
  const app = useAppState.getState()
  if (!app.busyThreads[threadId]) return true
  app.abortControllers[threadId]?.abort()
  app.cancelToolCalls[threadId]?.()
  return waitUntilIdle(threadId)
}

/** Remove every trace of the temporary chat from the stores that hold it. */
function sweepTemporaryState(): void {
  useMessages.getState().setMessages(TEMPORARY_CHAT_ID, [])
  useAppState.getState().clearThreadState(TEMPORARY_CHAT_ID)
  useModelOverrides.getState().dropThread(TEMPORARY_CHAT_ID)
  useThreads.getState().deleteThread(TEMPORARY_CHAT_ID)
}

export const useTemporaryChat = create<TemporaryChatState>()((set, get) => ({
  epoch: 0,
  busy: false,

  isCurrentEpoch: (epoch) => get().epoch === epoch,

  keep: async () => {
    if (get().busy) return { ok: false, reason: 'error', detail: 'busy' }
    set({ busy: true })
    try {
      const threads = useThreads.getState()
      const temporary = threads.threads[TEMPORARY_CHAT_ID]
      const messages = useMessages.getState().getMessages(TEMPORARY_CHAT_ID)
      // No chat, or one with no model recorded: there is nothing coherent to
      // copy, and inventing a model would put the kept thread on something the
      // conversation never used.
      if (!temporary?.model) {
        return { ok: false, reason: 'thread-not-created', detail: 'no chat' }
      }

      // A half-written answer would be copied mid-sentence and then keep
      // streaming into an id the kept thread does not own.
      if (!(await stopGeneration(TEMPORARY_CHAT_ID))) {
        return { ok: false, reason: 'generation-not-stopped' }
      }

      const overrides = overridesToCarry(
        useModelOverrides.getState().forThread(TEMPORARY_CHAT_ID)
      )
      const firstUserText = messages.find((m) => m.role === 'user')?.content?.[0]
        ?.text?.value

      // Created through the normal path, so it gets a fresh ulid and is
      // written like any other thread.
      const created = await threads.createThread(
        temporary.model,
        titleForKeptChat(firstUserText, 'Kept chat'),
        temporary.assistants?.[0]
      )
      if (!created?.id || created.id === TEMPORARY_CHAT_ID) {
        return { ok: false, reason: 'thread-not-created' }
      }

      const carried = readdressMessages(messages, created.id)
      for (const message of carried) {
        await getServiceHub().messages().createMessage(message)
      }

      // The services swallow their own write errors, so the return values
      // above prove nothing. Read the thread back and confirm every message
      // is really there before anything is deleted.
      const persisted = await getServiceHub()
        .messages()
        .fetchMessages(created.id)
      if (!persistedEverything(carried, persisted)) {
        return { ok: false, reason: 'messages-not-persisted' }
      }

      useMessages.getState().setMessages(created.id, carried)
      if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
          useModelOverrides.getState().setForThread(created.id, key, value)
        }
      }

      // Only now: the conversation exists somewhere else.
      set({ epoch: get().epoch + 1 })
      sweepTemporaryState()
      return { ok: true, threadId: created.id }
    } catch (error) {
      return {
        ok: false,
        reason: 'error',
        detail: error instanceof Error ? error.message : String(error),
      }
    } finally {
      set({ busy: false })
    }
  },

  discard: async () => {
    if (get().busy) return { ok: false, reason: 'busy' }
    set({ busy: true })
    try {
      // Stopped first and confirmed stopped: tearing the state out from under
      // a live stream would leave it writing into an id the next temporary
      // chat is about to use.
      if (!(await stopGeneration(TEMPORARY_CHAT_ID))) {
        return { ok: false, reason: 'generation-not-stopped' }
      }
      // Bumped before the sweep, so anything already in flight that checks
      // its epoch on the way back finds it stale.
      set({ epoch: get().epoch + 1 })
      sweepTemporaryState()
      return { ok: true }
    } finally {
      set({ busy: false })
    }
  },
}))
