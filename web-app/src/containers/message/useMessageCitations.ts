import { useEffect, useMemo } from 'react'
import type { UIMessage } from 'ai'
import { assistantTextOf, collectToolCitations } from '@/lib/messageParts'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useGroundingStore } from '@/stores/grounding-store'
import { useWebCitationStore } from '@/stores/web-citation-store'

/**
 * A message's tool citations (RAG and web), its sentence grounding, and the
 * effects that compute the grounding once the reply settles and publish the
 * web citations. Split out of `MessageItem`, which calls it at the same point
 * in its hook order.
 */
export function useMessageCitations(message: UIMessage, isStreaming: boolean) {
  // Aggregate RAG citations in part order and record each rag tool part's
  // base offset, so its card numbers/anchors continue the same global
  // sequence the inline superscript markers use.
  const { ragCitations, citationOffsets, webCitations, webReads } = useMemo(
    () => collectToolCitations(message.role, message.parts),
    [message.parts, message.role]
  )

  const serviceHub = useServiceHub()
  const grounding = useGroundingStore((s) => s.byMessageId[message.id])
  const ensureGrounding = useGroundingStore((s) => s.ensure)

  const assistantText = useMemo(
    () => assistantTextOf(message.role, message.parts),
    [message.parts, message.role]
  )

  useEffect(() => {
    if (isStreaming) return
    if (!assistantText || !ragCitations.length) return
    const rag = serviceHub.rag()
    if (!rag.embed) return
    ensureGrounding(
      message.id,
      assistantText,
      ragCitations,
      rag.embed.bind(rag)
    )
  }, [
    isStreaming,
    assistantText,
    ragCitations,
    message.id,
    ensureGrounding,
    serviceHub,
  ])

  const setWebCitations = useWebCitationStore((s) => s.setForMessage)
  useEffect(() => {
    if (!webCitations.length) return
    setWebCitations(message.id, webCitations)
  }, [webCitations, message.id, setWebCitations])

  return { citationOffsets, webCitations, webReads, grounding }
}
