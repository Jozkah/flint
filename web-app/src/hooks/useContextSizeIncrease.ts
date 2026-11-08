import { useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import type { ServiceHub } from '@/services'
import type { useConversationModel } from '@/hooks/useConversationPane'
import { useModelProvider } from '@/hooks/useModelProvider'
import { effectiveContextLength } from '@/lib/engineModels'
import { unloadForContextResize } from '@/lib/contextResizeUnload'
import { stampContextErrorOnThread } from '@/lib/chat/threadHelpers'
import {
  hasPartial,
  partialOf,
  type PartialContent,
} from '@/lib/chat/chatFinishHandler'
import { OUT_OF_CONTEXT_SIZE } from '@/utils/error'

type PendingContinuation = { message: UIMessage; content: PartialContent }

/**
 * The context banner's "Increase Context Size": steps the model's window up,
 * reloads it, and resumes the reply that stopped from its partial text.
 * Lifted out of ThreadConversation.tsx unchanged, memoized on the same values.
 */
export function useContextSizeIncrease({
  threadId,
  selectedModel,
  selectedProvider,
  getProviderByName,
  serviceHub,
  handleRegenerate,
  chatMessagesRef,
  pendingContinuationRef,
  setContinueFromContentRef,
  continueReplaceIdRef,
  regenerateTimerRef,
  setContextLimitError,
  setPendingContinueMessage,
}: {
  threadId: string
  selectedModel: ReturnType<typeof useConversationModel>['selectedModel']
  selectedProvider: string
  getProviderByName: ReturnType<typeof useModelProvider.getState>['getProviderByName']
  serviceHub: ServiceHub
  handleRegenerate: (messageId?: string) => void
  chatMessagesRef: MutableRefObject<UIMessage[]>
  pendingContinuationRef: MutableRefObject<PendingContinuation | null>
  setContinueFromContentRef: MutableRefObject<
    ((content: PartialContent) => void) | null
  >
  continueReplaceIdRef: MutableRefObject<string | null>
  regenerateTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  setContextLimitError: (error: Error | null) => void
  setPendingContinueMessage: (message: UIMessage | null) => void
}) {
  return useCallback(async () => {
    if (!selectedModel) return

    // The reply this click resumes when the turn that stopped left nothing in
    // pendingContinuationRef (a restart or a remount empties it): the stored
    // partial, marked `stopped`, that hydration restored. Read before the
    // awaits below, while the transcript is still this thread's.
    const lastMessage = chatMessagesRef.current.at(-1)
    const storedContent =
      lastMessage?.role === 'assistant' &&
      (lastMessage.metadata as { stopped?: boolean } | undefined)?.stopped
        ? partialOf(lastMessage)
        : undefined
    const storedPartial =
      lastMessage && storedContent && hasPartial(storedContent)
        ? { message: lastMessage, content: storedContent }
        : null

    const updateProvider = useModelProvider.getState().updateProvider
    const provider = getProviderByName(selectedProvider)
    if (!provider) return

    const modelIndex = provider.models.findIndex(
      (m) => m.id === selectedModel.id
    )
    if (modelIndex === -1) return

    const model = provider.models[modelIndex]

    // Increase context length in steps: <8192 -> 8192 -> 32768 -> x1.5
    // A blank Context Size runs at the provider's Default context size, so
    // step up from that, not from 8192.
    const currentCtxLen = effectiveContextLength(model, provider) ?? 8192
    const maxCtxLen =
      (model.settings?.ctx_len?.controller_props?.max as number) || 131072

    let newCtxLen: number
    if (currentCtxLen < 8192) {
      newCtxLen = 8192
    } else if (currentCtxLen < 32768) {
      newCtxLen = 32768
    } else {
      newCtxLen = Math.round(currentCtxLen * 1.5)
    }

    newCtxLen = Math.min(newCtxLen, maxCtxLen)
    if (newCtxLen <= currentCtxLen) {
      stampContextErrorOnThread(threadId)
      setContextLimitError(new Error(OUT_OF_CONTEXT_SIZE))
      return
    }

    const updatedModel = {
      ...model,
      settings: {
        ...model.settings,
        ctx_len: {
          ...(model.settings?.ctx_len ?? {}),
          controller_props: {
            ...(model.settings?.ctx_len?.controller_props ?? {}),
            value: newCtxLen,
          },
        },
      },
    }

    const updatedModels = [...provider.models]
    updatedModels[modelIndex] = updatedModel as Model

    updateProvider(provider.provider, {
      models: updatedModels,
    })

    // For llamacpp the router reads ctx-size from the preset, not from any
    // request param — so we must write model.yml and bounce the router before
    // the regenerate, otherwise the next load picks up the OLD context size.
    // Other providers consume the new Zustand value directly on next load.
    if (provider.provider === 'llamacpp') {
      try {
        await serviceHub
          .models()
          .updateModelSettings(selectedModel.id, { ctx_len: newCtxLen })
      } catch (e) {
        updateProvider(provider.provider, {
          models: provider.models,
        })
        console.error('Failed to persist increased ctx_len', e)
        stampContextErrorOnThread(threadId)
        setContextLimitError(new Error(OUT_OF_CONTEXT_SIZE))
        return
      }
    } else {
      // MLX's unload throws when no session is tracked for the model (it was
      // never loaded, or already unloaded). The new ctx_len still applies on
      // the next load, so a failed unload must not abort the resize.
      await unloadForContextResize(
        (id) => serviceHub.models().stopModel(id),
        selectedModel.id
      )
    }

    // Resume from the partial the reply stopped at: the one captured at the
    // `finishReason === 'length'` event, or, when none was, the stored reply
    // read above. The regenerate then continues it, and the "Growing the
    // Mind…" shimmer renders while the model reloads.
    const pending = pendingContinuationRef.current ?? storedPartial
    pendingContinuationRef.current = null
    if (pending) {
      setContinueFromContentRef.current?.(pending.content)
      setPendingContinueMessage(pending.message)
      // The partial is stored (see onFinish), so the resumed reply replaces it
      // in place rather than forking a second version of the same answer.
      continueReplaceIdRef.current = pending.message.id
    }

    if (regenerateTimerRef.current) clearTimeout(regenerateTimerRef.current)
    regenerateTimerRef.current = setTimeout(() => {
      regenerateTimerRef.current = null
      handleRegenerate(pending?.message.id)
    }, 1000)
    // The refs and state setters it also reads are stable, as they were when
    // this lived in the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedModel,
    selectedProvider,
    getProviderByName,
    serviceHub,
    handleRegenerate,
    threadId,
  ])
}
