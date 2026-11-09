import { useRemoteChatActions } from '@/lib/remote/composer'
import { useCallback, useEffect, useRef } from 'react'
import { useThreads } from '@/hooks/useThreads'
import { forkThread } from '@/lib/forkThread'
import { useMessages } from '@/hooks/useMessages'
import { hasPartial, partialOf } from '@/lib/chat/chatFinishHandler'
import {
  BRANCH_CHANGED_EVENT,
  repairActiveRoot,
  setActiveBranch as setActiveBranchFor,
} from '@/lib/branchSelect'
import { useMessageErrors } from '@/stores/message-errors'
import { useAppState } from '@/hooks/useAppState'
import { useLatestCallback } from '@/hooks/useLatestCallback'
import type { useChat } from '@/hooks/use-chat'
import { generateId } from 'ai'
import { convertThreadMessagesToUIMessages } from '@/lib/messages'
import { resolveAssistantParentIn } from '@/lib/assistantReply'
import { registerReplyContext } from '@/lib/persistInterruptedReplies'
import {
  computeActivePath,
  backfillParentIds,
  makeSibling,
  getSiblings,
  hasBranching,
  removeFromTree,
} from '@/lib/message-branching'
import { ThreadMessage } from '@janhq/core'
import { toast } from 'sonner'
import { route } from '@/constants/routes'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import type { useNavigate } from '@tanstack/react-router'
import type { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * Versions of a conversation: switching, regenerating, continuing, editing,
 * deleting and forking messages, and the active branch they act on. Lifted
 * out of ThreadConversation.tsx unchanged, in the same hook order.
 */
export function useThreadVersioning({
  threadId,
  updateMessage,
  addMessage,
  deleteMessage,
  setChatMessages,
  chatMessages,
  titleAbortRef,
  clearBannerErrors,
  stripBannerMetadata,
  contextLimitError,
  setContextLimitError,
  pendingAssistantParentId,
  continueReplaceIdRef,
  regenerate,
  setContinueFromContent,
  navigate,
  t,
}: {
  threadId: string
  updateMessage: ReturnType<typeof useMessages.getState>['updateMessage']
  addMessage: ReturnType<typeof useMessages.getState>['addMessage']
  deleteMessage: ReturnType<typeof useMessages.getState>['deleteMessage']
  setChatMessages: ReturnType<typeof useChat>['setMessages']
  chatMessages: UIMessage[]
  titleAbortRef: MutableRefObject<AbortController | null>
  clearBannerErrors: () => void
  stripBannerMetadata: () => void
  contextLimitError: Error | null
  setContextLimitError: Dispatch<SetStateAction<Error | null>>
  pendingAssistantParentId: MutableRefObject<string | null>
  continueReplaceIdRef: MutableRefObject<string | null>
  regenerate: ReturnType<typeof useChat>['regenerate']
  setContinueFromContent: ReturnType<typeof useChat>['setContinueFromContent']
  navigate: ReturnType<typeof useNavigate>
  t: ReturnType<typeof useTranslation>['t']
}) {
  // Versioning helpers --------------------------------------------------------

  // Assign parentId along the current linear path the first time a thread forks,
  // so siblings and subtrees are well-defined. Idempotent. Returns the store.
  const ensureBranched = useCallback(() => {
    const msgs = useMessages.getState().getMessages(threadId)
    if (hasBranching(msgs)) return msgs
    const filled = backfillParentIds(msgs)
    filled.forEach((m) => updateMessage(m))
    return useMessages.getState().getMessages(threadId)
  }, [threadId, updateMessage])

  // Make `node` the active branch under its parent (or active root).
  const setActiveBranch = useCallback(
    (node: ThreadMessage) => setActiveBranchFor(threadId, node),
    [threadId]
  )

  // Rebuild the rendered conversation from the active path in the store.
  const syncActivePath = useCallback(() => {
    const msgs = useMessages.getState().getMessages(threadId)
    const activeRootId = (
      useThreads.getState().threads[threadId]?.metadata as
        | Record<string, unknown>
        | undefined
    )?.activeRootId as string | undefined
    setChatMessages(
      convertThreadMessagesToUIMessages(computeActivePath(msgs, activeRootId))
    )
  }, [threadId, setChatMessages])

  // A version switched from the phone: show (and send from) the new path.
  useEffect(() => {
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<{ threadId?: string }>).detail?.threadId === threadId)
        syncActivePath()
    }
    window.addEventListener(BRANCH_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(BRANCH_CHANGED_EVENT, onChanged)
  }, [threadId, syncActivePath])

  // Switch the visible version of a message (the `< n/m >` control).
  const handleSwitchVersion = useCallback(
    (messageId: string, dir: -1 | 1) => {
      const msgs = useMessages.getState().getMessages(threadId)
      const target = msgs.find((m) => m.id === messageId)
      if (!target) return
      const siblings = getSiblings(msgs, target)
      const idx = siblings.findIndex((m) => m.id === messageId)
      const next = siblings[idx + dir]
      if (!next) return
      titleAbortRef.current?.abort()
      titleAbortRef.current = null
      clearBannerErrors()
      setActiveBranch(next)
      syncActivePath()
    },
    // Same dependencies as in ThreadConversation: the refs and setters it hands in are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, setActiveBranch, syncActivePath, clearBannerErrors]
  )

  // Resolve the user message that an assistant reply hangs off of.
  const resolveAssistantParent = useCallback(
    (messageId: string | undefined): string | null => {
      const activeRootId = (
        useThreads.getState().threads[threadId]?.metadata as
          | Record<string, unknown>
          | undefined
      )?.activeRootId as string | undefined
      return resolveAssistantParentIn(
        useMessages.getState().getMessages(threadId),
        activeRootId,
        messageId
      )
    },
    [threadId]
  )

  // What the quit path needs to save a reply that is still streaming the way
  // onFinish would: the stopped turn it continues and the turn it answers.
  useEffect(() => {
    if (!threadId) return
    return registerReplyContext(threadId, () => ({
      continueReplaceId: continueReplaceIdRef.current,
      parentId:
        pendingAssistantParentId.current ?? resolveAssistantParent(undefined),
    }))
  // Same dependencies as in ThreadConversation: the refs and setters it hands in are stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, resolveAssistantParent])

  // Regenerate keeps the previous reply as a prior version (no deletion); the
  // new reply arrives in onFinish as a sibling and becomes the active branch.
  // Fork this chat from a message into a new chat, and open it.
  const handleFork = useCallback(
    async (messageId: string) => {
      if (!threadId) return
      // A message off the shown branch fails here instead of forking another
      // branch in its place.
      const forkedId = await forkThread(threadId, messageId).catch(() => null)
      if (!forkedId) {
        toast.error(t('chat:fork.failed'))
        return
      }
      toast.success(t('chat:fork.done'))
      navigate({ to: route.threadsDetail, params: { threadId: forkedId } })
    },
    [threadId, navigate, t]
  )

  // Stable identity, latest closure: MessageItem's memo ignores callback
  // props, so a row that skipped a render must still see the current
  // `contextLimitError` when its Regenerate is clicked.
  const handleRegenerate = useLatestCallback(
    (messageId?: string) => {
      const hadBannerError =
        useAppState.getState().oomError != null ||
        useAppState.getState().backendError != null ||
        contextLimitError != null
      if (useAppState.getState().oomError) {
        useAppState.getState().setOomError(undefined)
      }
      if (useAppState.getState().backendError) {
        useAppState.getState().setBackendError(undefined)
      }
      if (contextLimitError) setContextLimitError(null)
      if (hadBannerError) stripBannerMetadata()
      titleAbortRef.current?.abort()
      titleAbortRef.current = null

      ensureBranched()
      pendingAssistantParentId.current = resolveAssistantParent(messageId)

      regenerate(messageId ? { messageId } : undefined)
    }
  )

  // The handlers passed to every MessageItem read the transcript through a
  // ref: depending on `chatMessages` gave them a new identity on every
  // streamed delta, which defeated MessageItem's memo and re-rendered the
  // whole transcript per delta.
  const chatMessagesRef = useRef(chatMessages)
  chatMessagesRef.current = chatMessages

  // Resume a turn that was stopped before it finished: replay the partial text
  // as an assistant prefill so the model continues from where it left off. The
  // transport re-emits the partial as the first delta, so the regenerated
  // message reconstitutes partial + new content and the KV cache is reused.
  const handleContinue = useCallback(
    (messageId: string) => {
      const msg = chatMessagesRef.current.find((m) => m.id === messageId)
      if (!msg) return
      const content = partialOf(msg)
      if (!hasPartial(content)) return
      setContinueFromContent(content)
      continueReplaceIdRef.current = messageId
      handleRegenerate(messageId)
    },
    // Same dependencies as in ThreadConversation: the refs and setters it hands in are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setContinueFromContent, handleRegenerate]
  )

  // Editing forks a new sibling version (the original + its subtree are kept).
  // User edits regenerate a reply for the new branch; assistant edits don't.
  const handleEditMessage = useCallback(
    (messageId: string, newText: string) => {
      const msgs = ensureBranched()
      const target = msgs.find((m) => m.id === messageId)
      if (!target) return

      useMessageErrors.getState().clearError(messageId)
      titleAbortRef.current?.abort()
      titleAbortRef.current = null

      const newId = generateId()
      const sibling = makeSibling(target, {
        id: newId,
        createdAt: Date.now(),
        text: newText,
      })
      addMessage(sibling)
      setActiveBranch(sibling)

      if (target.role === 'user') {
        pendingAssistantParentId.current = newId
        syncActivePath()
        regenerate({ messageId: newId })
      } else {
        syncActivePath()
      }
    },
    // Same dependencies as in ThreadConversation: the refs and setters it hands in are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      ensureBranched,
      addMessage,
      setActiveBranch,
      syncActivePath,
      regenerate,
    ]
  )

  // Handle delete message
  // A paired phone regenerates and edits through these same handlers.
  useRemoteChatActions(threadId, { regenerate: handleRegenerate, edit: handleEditMessage })

  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      // Re-link what hangs below the message before it goes. Deleting only the
      // row stranded its children behind a parent that no longer existed, and
      // the rest of the conversation disappeared from view (janhq/jan#8495).
      const stored = useMessages.getState().getMessages(threadId)
      const branched = hasBranching(stored)
      for (const m of removeFromTree(stored, [messageId])) updateMessage(m)
      repairActiveRoot(threadId, stored, [messageId])
      deleteMessage(threadId, messageId)
      useMessageErrors.getState().clearError(messageId)

      if (branched) {
        syncActivePath()
        return
      }
      // Update chat messages for UI
      const updatedChatMessages = chatMessagesRef.current.filter(
        (msg) => msg.id !== messageId
      )
      setChatMessages(updatedChatMessages)
    },
    [
      threadId,
      deleteMessage,
      updateMessage,
      syncActivePath,
      setChatMessages,
    ]
  )

  return {
    resolveAssistantParent,
    handleSwitchVersion,
    handleFork,
    handleRegenerate,
    chatMessagesRef,
    handleContinue,
    handleEditMessage,
    handleDeleteMessage,
  }
}
