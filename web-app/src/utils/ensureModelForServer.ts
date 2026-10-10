import { getModelToStart } from './getModelToStart'
import { useModelProvider } from '@/hooks/useModelProvider'
import { isLocalProvider } from '@/lib/utils'

export type EnsureModelResult =
  | { status: 'already_loaded'; modelId: string; providerName: string }
  | { status: 'loaded'; modelId: string; providerName: string }
  | { status: 'no_model_available' }

export interface EnsureModelDeps {
  /** Models service — typically `serviceHub.models()` */
  modelsService: {
    getActiveModels(provider?: string): Promise<string[]>
    startModel(
      provider: ModelProvider,
      model: string,
      bypassAutoUnload?: boolean
    ): Promise<unknown>
  }
  /** Override the model to load (e.g. user-configured default model). */
  modelOverride?: { model: string; provider: string } | null
  onLoadStart?: () => void
  onLoadEnd?: () => void
}

/** Find the provider that owns a given model ID. */
function findProviderForModel(modelId: string): ModelProvider | undefined {
  return useModelProvider
    .getState()
    .providers.find((p) =>
      p?.models?.some((m: { id: string }) => m.id === modelId)
    )
}

/** The first model of the first local-engine provider that has one. */
function firstLocalModel(
  providers: ModelProvider[] | undefined
): { model: string; provider: ModelProvider } | null {
  for (const provider of providers ?? []) {
    if (!isLocalProvider(provider.provider)) continue
    const first = provider.models?.[0]
    if (first) return { model: first.id, provider }
  }
  return null
}

/**
 * Ensure a model is loaded for the local API server.
 *
 * - If a model is already loaded, returns immediately.
 * - If no model is loaded, picks one via {@link getModelToStart} and loads it.
 *
 * The model is started with its existing context size settings (no enforcement).
 */
export async function ensureModelForServer(
  deps: EnsureModelDeps
): Promise<EnsureModelResult> {
  const { modelsService, modelOverride, onLoadStart, onLoadEnd } = deps

  const loadedModels = await modelsService.getActiveModels()

  if (loadedModels && loadedModels.length > 0) {
    const modelId = loadedModels[0]
    const providerName = findProviderForModel(modelId)?.provider ?? 'llamacpp'
    return { status: 'already_loaded', modelId, providerName }
  }

  // No model loaded — pick one (prefer user-configured default, then auto-pick)
  const { selectedModel, selectedProvider, getProviderByName, providers } =
    useModelProvider.getState()

  let modelToStart: { model: string; provider: ModelProvider } | null = null

  if (modelOverride) {
    const provider = getProviderByName(modelOverride.provider)
    if (provider && provider.models.some((m) => m.id === modelOverride.model)) {
      modelToStart = { model: modelOverride.model, provider }
    }
  }

  if (!modelToStart) {
    const picked = getModelToStart({
      selectedModel,
      selectedProvider,
      getProviderByName,
    })
    // The server serves local models. The last used or selected model is often
    // a remote one (a cloud API, a LAN server), and a remote provider has no
    // engine to load it into, so the start would fail with "engine is not
    // available". Use the first local model instead.
    modelToStart =
      picked && isLocalProvider(picked.provider.provider)
        ? picked
        : firstLocalModel(providers)
  }

  if (!modelToStart) {
    return { status: 'no_model_available' }
  }

  onLoadStart?.()
  try {
    await modelsService.startModel(modelToStart.provider, modelToStart.model, true)
    await new Promise((resolve) => setTimeout(resolve, 500))
  } finally {
    onLoadEnd?.()
  }

  return {
    status: 'loaded',
    modelId: modelToStart.model,
    providerName: modelToStart.provider.provider,
  }
}
