import { useJevSettings } from '@/hooks/useJevSettings'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelRouting } from '@/hooks/useModelRouting'
import { askToSwitchModel } from '@/lib/jevModelPrompt'
import {
  chooseJevModel,
  messageNeeds,
  resolvePool,
  type ModelTarget,
} from '@/lib/jevModelRouting'
import { getProviderTitle } from '@/lib/utils'
import { knownContextWindow } from '@/lib/knownContextWindow'

type ModelState = ReturnType<typeof useModelProvider.getState>
/** What a transport's `getModelSelection()` answers with. */
export type ModelSelection = Pick<ModelState, 'selectedProvider' | 'selectedModel'>

/** The picker-shaped selection for a routed model, from its provider's own model entry. */
export function selectionFor(target: Pick<ModelTarget, 'provider' | 'model'>): ModelSelection | undefined {
  const provider = useModelProvider.getState().providers.find((p) => p.provider === target.provider)
  const model = provider?.models.find((m) => m.id === target.model)
  return model ? { selectedProvider: target.provider, selectedModel: model } : undefined
}

/**
 * Decide the model for one message, for Chat and for Cowork.
 *
 * Returns a selection only when the person turned this on, Jev's own opt-in is
 * On, and another listed model is clearly better (and, in Ask first mode, the
 * person agreed). Everything else keeps the current model, which is the usual
 * outcome. `requireTools` is for a surface whose turns are all tool use
 * (Cowork), where a model that cannot call tools is never an option.
 */
export async function routeModelForTurn(args: {
  message: string
  parts: ReadonlyArray<{ type: string; mediaType?: string }>
  current: ModelSelection
  temporary: boolean
  requireTools?: boolean
  /**
   * Never offer a model with a known context window smaller than the current
   * one's. For a surface that sizes compaction from the session's model
   * (Cowork), where a smaller window would be overrun before it compacts.
   */
  keepContextWindow?: boolean
  signal?: AbortSignal
}): Promise<{ target: ModelTarget; selection: ModelSelection } | null> {
  const routing = useModelRouting.getState()
  if (routing.mode === 'off' || routing.pool.length === 0 || args.temporary) return null
  // Jev's own opt-in governs whether anything may be asked.
  if (useJevSettings.getState().skillMode !== 'on') return null
  const { selectedProvider, selectedModel } = args.current
  if (!selectedProvider || !selectedModel) return null

  const providers = useModelProvider.getState().providers
  let pool = resolvePool(routing.pool, providers)
  if (args.keepContextWindow) {
    const currentProviderObject = providers.find((p) => p.provider === selectedProvider)
    const floor = knownContextWindow(selectedModel, currentProviderObject)
    if (floor) {
      pool = pool.filter((t) => {
        const provider = providers.find((p) => p.provider === t.provider)
        const window = knownContextWindow(provider?.models.find((m) => m.id === t.model), provider)
        return window === null || window >= floor
      })
    }
  }
  const currentProvider = providers.find((p) => p.provider === selectedProvider)
  const capabilities = selectedModel.capabilities ?? []
  const current = {
    provider: selectedProvider,
    model: selectedModel.id,
    label: `${currentProvider?.displayName || getProviderTitle(selectedProvider)} / ${selectedModel.displayName || selectedModel.id}`,
    local: selectedProvider === 'llamacpp' || selectedProvider === 'mlx',
    capabilities,
  }
  const needs = messageNeeds(args.parts, capabilities)
  if (args.requireTools) needs.tools = true

  const decision = await chooseJevModel({
    message: args.message,
    current,
    pool,
    needs,
    signal: args.signal,
  })
  const target = decision?.target
  if (!target) return null
  if (routing.mode === 'ask') {
    const accepted = await askToSwitchModel({
      currentLabel: current.label,
      targetLabel: target.label,
      signal: args.signal,
    })
    if (!accepted) return null
  }
  const selection = selectionFor(target)
  return selection ? { target, selection } : null
}
