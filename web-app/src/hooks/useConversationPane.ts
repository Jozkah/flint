import { createContext, useContext, useMemo } from 'react'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import type { SplitPaneId } from '@/hooks/useSplitConversation'

/**
 * Which conversation pane a component is rendered in.
 *
 * Absent outside the Chat thread view. With the split closed there is one
 * pane and it is always active, so everything reads exactly as it did before
 * split conversations existed.
 */
export type ConversationPane = {
  paneId: SplitPaneId
  threadId: string
  /** Two panes are on screen. */
  isSplit: boolean
  /** The pane the user is working in. Only it drives global selections. */
  isActive: boolean
}

export const ConversationPaneContext = createContext<ConversationPane | null>(
  null
)

export function useConversationPane(): ConversationPane | null {
  return useContext(ConversationPaneContext)
}

type ProviderState = ReturnType<typeof useModelProvider.getState>

export type ModelSelection = Pick<
  ProviderState,
  'selectedProvider' | 'selectedModel'
>

/**
 * The selection a thread's recorded model stands for, or the given global
 * selection when the thread has none or its model is gone. Pure, so a
 * component that already holds the stores' state can use it without
 * subscribing again.
 */
export function selectionForThreadModel(
  threadModel: ThreadModel | undefined,
  state: Pick<
    ProviderState,
    'selectedProvider' | 'selectedModel' | 'getProviderByName'
  >
): ModelSelection {
  const fallback = {
    selectedProvider: state.selectedProvider,
    selectedModel: state.selectedModel,
  }
  if (!threadModel?.id || !threadModel.provider) return fallback
  const provider = state.getProviderByName?.(threadModel.provider)
  const model = provider?.models?.find((m) => m.id === threadModel.id)
  if (!model) return fallback
  return { selectedProvider: threadModel.provider, selectedModel: model }
}

/**
 * The provider and model a thread sends with when it is one of two panes: the
 * model recorded on the thread itself, not the global picker, which follows
 * whichever pane is active. Falls back to the global picker when the thread
 * has no model or its model is no longer available.
 */
export function resolveThreadModelSelection(threadId: string): ModelSelection {
  const threadModel = useThreads.getState().threads?.[threadId]?.model
  return selectionForThreadModel(threadModel, useModelProvider.getState())
}

/**
 * The model this conversation uses, for display and capability checks.
 *
 * Inside a split pane: the pane's own thread model. Otherwise: the global
 * picker, unchanged.
 */
export function useConversationModel(): ModelSelection {
  const pane = useConversationPane()
  const scopedThreadId = pane?.isSplit ? pane.threadId : undefined
  const selectedModel = useModelProvider((s) => s.selectedModel)
  const selectedProvider = useModelProvider((s) => s.selectedProvider)
  const getProviderByName = useModelProvider((s) => s.getProviderByName)
  // Subscribed so a pane re-renders when a provider's model list changes.
  const providers = useModelProvider((s) => s.providers)
  const threadModel = useThreads((s) =>
    scopedThreadId ? s.threads?.[scopedThreadId]?.model : undefined
  )

  return useMemo(() => {
    if (!scopedThreadId) return { selectedModel, selectedProvider }
    return selectionForThreadModel(threadModel, {
      selectedModel,
      selectedProvider,
      getProviderByName,
    })
    // `providers` is the reason getProviderByName's answer can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scopedThreadId,
    threadModel?.id,
    threadModel?.provider,
    selectedModel,
    selectedProvider,
    getProviderByName,
    providers,
  ])
}
