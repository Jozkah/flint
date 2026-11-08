import type { MutableRefObject } from 'react'
import { engineSlotsIdle } from '@janhq/tauri-plugin-llamacpp-api'
import { getActiveMessages } from '@/hooks/useActiveMessages'
import { useThreads } from '@/hooks/useThreads'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { resolveThreadModelSelection } from '@/hooks/useConversationPane'
import { generateThreadTitle } from '@/lib/thread-title-summarizer'
import {
  AUTO_TITLE_SOURCE_KEY,
  beginAutoTitle,
  decideAutoTitle,
  endAutoTitle,
} from '@/lib/threadAutoTitle'

/**
 * Titles a Chat conversation after a reply, when it is due (see
 * lib/threadAutoTitle). Lifted out of the conversation's onFinish
 * (ThreadConversation.tsx) unchanged; `titleAbortRef` is the conversation's,
 * so a send or an edit still cancels a title in flight.
 */
export function maybeAutoTitleChat(
  threadId: string,
  titleAbortRef: MutableRefObject<AbortController | null>
): void {
  // The titled conversation is the one on screen, not every version.
  const localMessages = getActiveMessages(threadId)
  const currentThread = useThreads.getState().threads[threadId]
  // Once per chat, and again only when the first message was edited
  // (see lib/threadAutoTitle).
  const titleDecision = decideAutoTitle({
    threadId,
    enabled: useInterfaceSettings.getState().autoGenerateTitle,
    metadata: currentThread?.metadata,
    messages: localMessages,
  })
  const recordTitleSource = (source: string, title?: string) => {
    const latest = useThreads.getState().threads[threadId]
    if (!latest || latest.metadata?.titleSetManually) return
    useThreads.getState().updateThread(threadId, {
      ...(title ? { title } : {}),
      metadata: { ...latest.metadata, [AUTO_TITLE_SOURCE_KEY]: source },
    })
  }
  if (titleDecision.kind === 'adopt') {
    recordTitleSource(titleDecision.source)
  } else if (titleDecision.kind === 'generate') {
    const titleSource = titleDecision.source
    const TITLE_TRANSCRIPT_MAX_TURNS = 8
    const recent = localMessages.slice(-TITLE_TRANSCRIPT_MAX_TURNS)
    const inputText =
      recent
        .map((m) => {
          const text = m.content
            ?.map((c) => c?.text?.value ?? '')
            .join('')
            .trim()
          if (!text) return ''
          const role = m.role === 'assistant' ? 'Assistant' : 'User'
          return `${role}: ${text}`
        })
        .filter(Boolean)
        .join('\n\n') ||
      useThreads.getState().threads[threadId]?.title
    if (inputText) {
      // The owning thread's model, not the global picker: switching the
      // picker mid-reply must not move the title gate to another provider.
      const titleSelection = resolveThreadModelSelection(threadId)
      const provider = titleSelection.selectedProvider
      const modelId = titleSelection.selectedModel?.id
      beginAutoTitle(threadId, titleSource)
      ;(async () => {
        if (provider === 'llamacpp' && modelId) {
          let idle = false
          for (let attempt = 0; attempt < 6; attempt++) {
            try {
              idle = await engineSlotsIdle(modelId)
            } catch {
              idle = true
              break
            }
            if (idle) break
            await new Promise((r) => setTimeout(r, 150))
          }
          if (!idle) return
        }
        titleAbortRef.current?.abort()
        const controller = new AbortController()
        titleAbortRef.current = controller
        const title = await generateThreadTitle(
          inputText,
          controller.signal,
          threadId,
          titleSource
        )
        if (controller.signal.aborted) return
        // Recorded even when no title came back, so a model that cannot
        // title is not asked again on every reply.
        recordTitleSource(titleSource, title ?? undefined)
        titleAbortRef.current = null
      })().finally(() => endAutoTitle(threadId, titleSource))
    }
  }
}
