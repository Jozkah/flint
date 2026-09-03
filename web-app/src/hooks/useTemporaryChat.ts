import { create } from 'zustand'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { useMessages } from '@/hooks/useMessages'
import { useAppState } from '@/hooks/useAppState'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import {
  overridesToCarry,
  persistedEverything,
  persistedThread,
  readdressMessages,
  titleForKeptChat,
  type PromotionFailure,
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
 *
 * On late events and the reused id: the sweep never runs until `stopGeneration`
 * has confirmed the chat is idle, and the chat is not marked idle
 * (`busyThreads`) until its send flow has finished writing its final message.
 * So a late write cannot land *after* the sweep — the sweep waits for it — and
 * the sweep is exhaustive, so nothing it leaves behind can be inherited by the
 * next chat under the same id.
 */

/** How long to wait for a cancelled generation to actually stop. */
const CANCEL_TIMEOUT_MS = 5000
const CANCEL_POLL_MS = 50

type TemporaryChatState = {
  /**
   * A promotion or discard in flight; the dialog and banner disable while it
   * runs. For a keep this stays true across the caller's navigation onto the
   * saved thread and is only released by `finalizeKept`, so a second keep or a
   * discard cannot fire into the still-intact temporary chat during that
   * window.
   */
  busy: boolean
  /**
   * True from the moment a keep begins until its state has been swept.
   *
   * The one navigation a keep performs — onto the thread it just wrote — is a
   * navigation *away* from the temporary chat, which is exactly what the router
   * guard is watching for. Without a way to say "this leaving is the one I
   * asked for," the guard would re-open its own dialog on top of the chat it is
   * in the middle of keeping. The guard reads this and lets that one through.
   */
  leaving: boolean

  /**
   * Copy the temporary chat into a real thread, and confirm — through a
   * non-optimistic read, not the store the write already touched — that both
   * the thread and every message are durably there. Nothing is deleted: the
   * temporary chat is left completely intact for the caller to navigate off
   * first. Call `finalizeKept` once that navigation has happened.
   *
   * `busy` is held true on success until `finalizeKept` releases it, so the
   * still-intact temporary chat cannot be kept or discarded a second time
   * during the caller's navigation. On any failure the temporary chat is
   * untouched and any half-written permanent thread is rolled back, so a retry
   * starts from a clean slate.
   */
  keep: () => Promise<PromotionResult>
  /**
   * Clear the temporary chat after a successful `keep` and the navigation off
   * it, and release `busy`. Split from `keep` so the order the caller sees is:
   * persist, confirm, navigate, *then* forget — never forgetting a chat that is
   * still on screen. The caller must always call it (from a `finally`) so
   * `busy`/`leaving` are never left stuck if the navigation itself throws.
   */
  finalizeKept: () => void
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
  // Attachments staged under the chat's id but never sent. Left behind, the
  // next temporary chat would inherit — and could unknowingly send — them.
  useChatAttachments.getState().clearAttachments(TEMPORARY_CHAT_ID)
  useThreads.getState().deleteThread(TEMPORARY_CHAT_ID)
}

/**
 * Undo a permanent thread that was created but never confirmed.
 *
 * A keep that gets a thread onto disk but then cannot prove its messages
 * landed has produced *partial permanent data*: a real thread, missing its
 * conversation. That thread must go — through the same durable delete path a
 * user would use, which cascades to any messages that did land — and the
 * caller must be put back where it was, on the temporary chat, which was never
 * touched.
 */
function rollbackPartialThread(threadId: string): void {
  useThreads.getState().deleteThread(threadId)
  useThreads.getState().setCurrentThreadId(TEMPORARY_CHAT_ID)
}

export const useTemporaryChat = create<TemporaryChatState>()((set, get) => ({
  busy: false,
  leaving: false,

  keep: async () => {
    if (get().busy) return { ok: false, reason: 'error', detail: 'busy' }
    set({ busy: true, leaving: true })

    // A thread id we managed to create before something later failed. Kept
    // outside the try so the failure path can roll it back exactly once.
    let createdId: string | undefined

    const fail = (reason: PromotionFailure, detail?: string): PromotionResult => {
      if (createdId) rollbackPartialThread(createdId)
      set({ busy: false, leaving: false })
      return { ok: false, reason, detail }
    }

    try {
      const threads = useThreads.getState()
      const temporary = threads.threads[TEMPORARY_CHAT_ID]
      const messages = useMessages.getState().getMessages(TEMPORARY_CHAT_ID)
      // No chat, or one with no model recorded: there is nothing coherent to
      // copy, and inventing a model would put the kept thread on something the
      // conversation never used.
      if (!temporary?.model) {
        return fail('thread-not-created', 'no chat')
      }
      // Nothing to keep. `persistedEverything([], …)` is vacuously true, so
      // without this an empty chat would "succeed" into an empty thread.
      if (messages.length === 0) {
        return fail('thread-not-created', 'no messages')
      }

      // A half-written answer would be copied mid-sentence and then keep
      // streaming into an id the kept thread does not own.
      if (!(await stopGeneration(TEMPORARY_CHAT_ID))) {
        return fail('generation-not-stopped')
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
        return fail('thread-not-created')
      }
      createdId = created.id

      // `createThread` swallows its own write errors, so the object above
      // proves nothing about disk. Read the thread list back from the
      // persistence boundary and confirm the thread is really there before a
      // single message is addressed to it.
      const persistedThreads = await getServiceHub().threads().fetchThreads()
      if (!persistedThread(created.id, persistedThreads)) {
        return fail('thread-not-created', 'not durable')
      }

      const carried = readdressMessages(messages, created.id)
      for (const message of carried) {
        await getServiceHub().messages().createMessage(message)
      }

      // `createMessage` swallows its errors too. Read the thread back and
      // confirm every message is really there. Nothing is deleted until this
      // says yes.
      const persisted = await getServiceHub()
        .messages()
        .fetchMessages(created.id)
      if (!persistedEverything(carried, persisted)) {
        return fail('messages-not-persisted')
      }

      useMessages.getState().setMessages(created.id, carried)
      if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
          useModelOverrides.getState().setForThread(created.id, key, value)
        }
      }

      // Persisted and confirmed. `busy` stays true and the temporary chat is
      // left in place: the caller navigates onto `created.id` and then calls
      // `finalizeKept`, which sweeps the chat and releases `busy`. Holding
      // `busy` closes the window in which the still-intact chat could be kept
      // or discarded a second time.
      return { ok: true, threadId: created.id }
    } catch (error) {
      return fail('error', error instanceof Error ? error.message : String(error))
    }
  },

  finalizeKept: () => {
    sweepTemporaryState()
    set({ leaving: false, busy: false })
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
      sweepTemporaryState()
      return { ok: true }
    } finally {
      set({ busy: false, leaving: false })
    }
  },
}))
