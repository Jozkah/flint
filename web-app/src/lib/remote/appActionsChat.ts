// `RemoteActions` for chats: creating one, and its model, reasoning and web search.

import { useThreads } from '@/hooks/useThreads'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { resolveThreadModelId } from '@/lib/models'
import { SESSION_STORAGE_PREFIX } from '@/constants/chat'
import { route } from '@/constants/routes'
import { RemoteRpcError } from './bridge'
import type { RemoteActions } from './actions'
import type { ModelRef } from './protocol'
import { resolveReplyModel } from '@/lib/resolveReplyModel'
import { useModelEvidence } from '@/hooks/useModelEvidence'
import { getLastUsedModel } from '@/utils/getModelToStart'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import type { AppActionContext } from './appActionsShared'

/** The chat composer's model-setting write (ChatInput `updateModelSetting`). */
function setModelSetting(model: ModelRef, key: string, title: string, value: unknown) {
  const store = useModelProvider.getState()
  const provider = store.getProviderByName(model.provider)
  if (!provider) return
  const index = provider.models.findIndex((m) => m.id === model.id)
  if (index === -1) return
  const current = provider.models[index]
  const existing = current.settings?.[key] ?? {
    key,
    title,
    description: '',
    controller_type: 'dropdown',
    controller_props: { value },
  }
  const updated = {
    ...current,
    settings: {
      ...current.settings,
      [key]: { ...existing, controller_props: { ...(existing.controller_props ?? {}), value } },
    },
  } as Model
  const models = [...provider.models]
  models[index] = updated
  store.updateProvider(model.provider, { models })
}

export function chatActions(ctx: AppActionContext): Pick<
  RemoteActions,
  | 'chatExists'
  | 'chatBusy'
  | 'createChat'
  | 'setWebSearch'
  | 'setChatReasoning'
  | 'setChatModel'
> {
  const { navigate, chatModelOf } = ctx
  return {
    chatExists: (id) => Boolean(useThreads.getState().threads[id]),
    chatBusy: (id) => Boolean(useAppState.getState().busyThreads[id]),

    createChat: async ({ text, model, reasoning, files, docs }) => {
      const providers = useModelProvider.getState()
      // The phone's new chat names no model until one is chosen. Then the
      // computer picks the way its own composer does: the selected model, else
      // the default, the last used one, or whatever can answer.
      const fallback =
        model || providers.selectedModel
          ? undefined
          : resolveReplyModel({
              providers: providers.providers,
              preferred: useModelEvidence.getState().preferredModel,
              lastUsed: getLastUsedModel(),
            })
      const provider =
        model?.provider ?? fallback?.provider ?? providers.selectedProvider
      const modelId = resolveThreadModelId(
        provider,
        model?.id ?? fallback?.model ?? providers.selectedModel?.id,
        (providers.getProviderByName(provider)?.models ?? []).map((m) => m.id)
      )
      if (!provider || !modelId) {
        throw new RemoteRpcError(
          'unavailable',
          'No model is installed or connected on the computer to answer with.'
        )
      }
      // The phone's Reasoning toggle belongs to the model the chat really got,
      // which is only known here once the fallback has been resolved.
      if (reasoning) setModelSetting({ id: modelId, provider }, 'reasoning', 'Reasoning', reasoning)
      const thread = await useThreads.getState().createThread({ id: modelId, provider }, text)
      // Documents wait in the composer's store, as if attached there.
      if (docs?.length) useChatAttachments.getState().setAttachments(thread.id, (prev) => [...prev, ...docs])
      // The first-message hand-off ChatInput uses: the conversation sends it
      // through its own path when it mounts.
      try {
        sessionStorage.setItem(
          `${SESSION_STORAGE_PREFIX.INITIAL_MESSAGE}${thread.id}`,
          JSON.stringify({ text, files: files ?? [] })
        )
      } catch {
        // Quota or storage blocked: no hand-off is possible, so do not leave
        // an empty thread behind for a request that reports failure.
        useThreads.getState().deleteThread(thread.id)
        throw new RemoteRpcError('unavailable', 'The attached files are too large to hand to a new chat')
      }
      navigate({ to: route.threadsDetail, params: { threadId: thread.id } })
      return thread.id
    },

    setWebSearch: (on) => useWebSearchConfig.getState().setWebSearchEnabled(on),

    setChatReasoning: (chatId, mode, model) => {
      const target =
        model ??
        (chatId ? chatModelOf(chatId) : undefined) ??
        (() => {
          const s = useModelProvider.getState()
          return s.selectedModel ? { id: s.selectedModel.id, provider: s.selectedProvider } : undefined
        })()
      if (target) setModelSetting(target, 'reasoning', 'Reasoning', mode)
    },

    setChatModel: (chatId, model) => {
      const threads = useThreads.getState()
      threads.updateThread(chatId, { model })
    },
  }
}
