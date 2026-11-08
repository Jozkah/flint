import { useEffect, useRef, useState } from 'react'
import { hasPartial } from '@/lib/chat/chatFinishHandler'
import type { useChat } from '@/hooks/use-chat'
import { toast } from 'sonner'
import {
  readChatCompaction,
  writeChatCompaction,
  registerChatCompactor,
  registerChatSideQuestion,
} from '@/lib/chatCompaction'
import { CompactionSummaryError, resolveAutoCompact } from '@/lib/compaction'
import { getCompactionPolicy } from '@/lib/compactionPolicy'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import type { useTranslation } from '@/i18n/react-i18next-compat'
import type { PartialContent } from '@/lib/chat/chatFinishHandler'

/**
 * Compaction in a chat: `/compact` and the banner's Compact button, compacting
 * after the window filled, `/btw` side questions, and the compaction in force.
 * Lifted out of ThreadConversation.tsx unchanged, in the same hook order.
 */
export function useChatCompaction({
  threadId,
  status,
  compactNow,
  sideQuestion,
  chatMessages,
  chatMessagesRef,
  handleRegenerate,
  t,
  thread,
  recoverContextLimitRef,
  setContinueFromContentRef,
  setPendingContinueMessage,
}: {
  threadId: string
  status: ReturnType<typeof useChat>['status']
  compactNow: ReturnType<typeof useChat>['compactNow']
  sideQuestion: ReturnType<typeof useChat>['sideQuestion']
  chatMessages: UIMessage[]
  chatMessagesRef: MutableRefObject<UIMessage[]>
  handleRegenerate: (messageId?: string) => void
  t: ReturnType<typeof useTranslation>['t']
  thread: Thread | undefined
  recoverContextLimitRef: MutableRefObject<
    ((message: UIMessage, partial: PartialContent) => Promise<boolean>) | null
  >
  setContinueFromContentRef: MutableRefObject<
    ((content: PartialContent) => void) | null
  >
  setPendingContinueMessage: Dispatch<SetStateAction<UIMessage | null>>
}) {
  /**
   * Compact this conversation now (`/compact`, the context banner's Compact
   * button). The summary is kept with the thread and every later request
   * sends it in place of the older messages; the divider marks where.
   */
  const [compacting, setCompacting] = useState(false)
  const handleCompact = async (
    opts: { thenRegenerate?: boolean; focus?: string } = {}
  ) => {
    if (compacting || status === 'streaming' || status === 'submitted') return
    setCompacting(true)
    const before = readChatCompaction(threadId)
    try {
      const record = await compactNow(chatMessages, opts.focus)
      if (!record) {
        toast.info(t('common:budget.compactFailed'))
        return
      }
      toast.success(
        t('common:budget.compactDone', { model: record.model ?? '' }),
        {
          action: {
            label: t('common:budget.compactUndo'),
            onClick: () => {
              // Messages are kept whole in Chat; undoing forgets the summary
              // so requests send the full history again. Only while it is
              // still this compaction in force.
              if (readChatCompaction(threadId)?.record.at !== record.at) {
                toast.info(t('common:budget.compactUndoStale'))
                return
              }
              writeChatCompaction(threadId, before)
            },
          },
        }
      )
      // From the context banner: the request failed for room, so it is sent
      // again on the room compaction freed.
      if (opts.thenRegenerate) handleRegenerate()
    } catch (e) {
      console.warn('[chat] compaction failed', e)
      toast.error(
        e instanceof CompactionSummaryError
          ? t('common:budget.compactFailedReason', { reason: e.reason })
          : t('common:budget.compactFailed')
      )
    } finally {
      setCompacting(false)
    }
  }
  const handleCompactRef = useRef(handleCompact)
  handleCompactRef.current = handleCompact
  // A reply cut off by the window filling: compact, then continue it from the
  // partial text. Nothing caps how often this can happen in one run -- each
  // pass has to fold something, and when nothing is left to fold the banner
  // takes over -- so the window is the only limit.
  recoverContextLimitRef.current = async (message, partial) => {
    try {
      const policy = await getCompactionPolicy()
      const params = thread?.assistants?.[0]?.parameters as
        | Record<string, unknown>
        | undefined
      if (
        !resolveAutoCompact(params, policy.auto) ||
        policy.strategy !== 'summarize'
      ) {
        return false
      }
      // Without the partial reply: it is regenerated below, and a summary
      // boundary on a message that is about to be replaced would be lost.
      const record = await compactNow(
        chatMessagesRef.current.filter((m) => m.id !== message.id)
      )
      if (!record) return false
      if (hasPartial(partial)) {
        setContinueFromContentRef.current?.(partial)
        setPendingContinueMessage(message)
      }
      handleRegenerate()
      return true
    } catch (e) {
      console.warn('[chat] compaction after the window filled failed', e)
      return false
    }
  }
  useEffect(
    () =>
      registerChatCompactor(threadId, (focus) =>
        handleCompactRef.current({ focus })
      ),
    [threadId]
  )
  // `/btw <question>`: answered from a snapshot, shown in a toast, never
  // added to the thread; reads a copy so it also works while a reply streams.
  const sideQuestionRef = useRef(sideQuestion)
  sideQuestionRef.current = sideQuestion
  useEffect(
    () =>
      registerChatSideQuestion(threadId, async (question) => {
        try {
          const answer = await sideQuestionRef.current(
            chatMessagesRef.current,
            question
          )
          if (!answer) throw new Error('no answer')
          toast.info(`/btw ${question}`, {
            description: answer,
            duration: 60_000,
            closeButton: true,
          })
        } catch (e) {
          console.warn('[chat] side question failed', e)
          toast.error(t('common:budget.btwFailed'))
        }
      }),
    // Same dependencies as in ThreadConversation: the refs and setters it hands in are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, t]
  )
  // The compaction in force, drawn at its boundary unless the reply after it
  // already carries it.
  const compactionInForce = readChatCompaction(threadId)
  const compactionShownOnReply =
    !!compactionInForce &&
    chatMessages.some(
      (m) =>
        (m.metadata as { compaction?: { at?: number } } | undefined)
          ?.compaction?.at === compactionInForce.record.at
    )

  return { compacting, handleCompact, compactionInForce, compactionShownOnReply }
}
