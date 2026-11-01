import { syncListedModels } from '@/lib/providerModelSync'
import { listedCapabilities } from '@/lib/listedCapabilities'
import { initialModelCapabilities } from '@/lib/models'
import { classifyModelLocation } from '@/lib/modelLocation'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getProviderTitle } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'
import { toast } from 'sonner'
import { useEffect, useState } from 'react'
import { takeFirstModelFetch } from '@/lib/pendingFirstModelFetch'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useAppState } from '@/hooks/useAppState'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { errorText } from '@/lib/errorText'
import { describeEngineError, parseEngineError } from '@/lib/engineError'

type ProviderOf = ReturnType<typeof useModelProvider.getState>['providers'][number]

/** Refreshing a provider's model list and starting or stopping its models. */
export function useProviderModelActions({
  provider,
  providerName,
  serviceHub,
  updateProvider,
  onConnection,
}: {
  provider: ProviderOf | undefined
  providerName: string
  serviceHub: ReturnType<typeof useServiceHub>
  updateProvider: ReturnType<typeof useModelProvider.getState>['updateProvider']
  /** A refresh settled: the connection is verified or shown to have failed. */
  onConnection: (verified: boolean) => void
}) {
  const { t } = useTranslation()
  const { setModelLoadError } = useModelLoad()
  const setActiveModels = useAppState((state) => state.setActiveModels)
  const [loadingModels, setLoadingModels] = useState<string[]>([])
  /** Models whose last start from this page threw; cleared by a success. */
  const [failedModels, setFailedModels] = useState<string[]>([])
  const [refreshingModels, setRefreshingModels] = useState(false)

  const handleRefreshModels = async () => {
    if (!provider || !provider.base_url) {
      toast.error(t('providers:models'), {
        description: t('providers:refreshModelsError'),
      })
      return
    }
    // Only an endpoint that is *definitely* public is asked for a key up
    // front. A local one needs no credential, and a single-label hostname like
    // `llm-host` is not yet known to be either -- refusing those meant Flint told
    // the user to "configure an API key" for a server that never asked for
    // one, and never sent the request that would have said what was actually
    // wrong. Where it is not certain, make the request and report the answer.
    if (
      classifyModelLocation({ baseUrl: provider.base_url }) === 'remote' &&
      !providerHasRemoteApiKeys(provider)
    ) {
      toast.error(t('providers:models'), {
        description: t('providers:refreshModelsError'),
      })
      return
    }

    setRefreshingModels(true)
    try {
      const modelIds = await serviceHub
        .providers()
        .fetchModelsFromProvider(provider)
      onConnection(true)
      const newModels: Model[] = modelIds.map((id) => ({
        id,
        model: id,
        name: id,
        capabilities: initialModelCapabilities(
          provider.provider,
          id,
          listedCapabilities(provider.base_url, id)
        ),
        version: '1.0',
      }))


      // What the server lists is the truth: new models come in, and models it
      // no longer lists go, so the model menu stops offering them.
      const synced = syncListedModels(
        provider.models,
        modelIds,
        (id) => newModels.find((m) => m.id === id) as Model
      )
      const modelsToAdd = synced.added

      if (modelsToAdd.length > 0 || synced.removed.length > 0) {
        updateProvider(providerName, {
          ...provider,
          models: synced.models,
        })

        // Short, and one at a time: a long-lived card sat over the Save button of
        // a dialog opened right after a refresh.
        toast.success(t('providers:models'), {
          id: 'providers-models-refresh',
          duration: 2500,
          description: [
            modelsToAdd.length > 0
              ? t('providers:refreshModelsSuccess', {
                  count: modelsToAdd.length,
                  provider: getProviderTitle(provider.provider),
                })
              : null,
            synced.removed.length > 0
              ? t('providers:refreshModelsRemoved', { count: synced.removed.length })
              : null,
          ]
            .filter(Boolean)
            .join(' '),
        })
      } else {
        toast.success(t('providers:models'), {
          id: 'providers-models-refresh',
          duration: 2500,
          description: t('providers:noNewModels'),
        })
      }
    } catch (error) {
      onConnection(false)
      console.error(
        t('providers:refreshModelsFailed', { provider: getProviderTitle(provider.provider) }),
        error
      )
      // Show what actually failed. The service throws a message naming the
      // endpoint, the status and whoever answered; replacing it with "check
      // your API key and base URL" hid a proxy answering 403 for a server the
      // user believed was local, and pointed at the one thing that was fine.
      toast.error(t('providers:models'), {
        description: errorText(
          error,
          t('providers:refreshModelsFailed', { provider: getProviderTitle(provider.provider) })
        ),
      })
    } finally {
      setRefreshingModels(false)
    }
  }

  // A provider the user has just added lists its models without a manual
  // click: one refresh, through the same action as the button, no polling.
  useEffect(() => {
    if (!provider?.base_url) return
    if (takeFirstModelFetch(providerName)) void handleRefreshModels()
    // Runs for the provider on screen, not for every later store change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerName, provider?.base_url])

  const handleStartModel = async (modelId: string) => {
    // Add model to loading state
    setLoadingModels((prev) => [...prev, modelId])
    if (provider) {
      try {
        // Start the model with plan result
        await serviceHub.models().startModel(provider, modelId)
        setFailedModels((prev) => prev.filter((id) => id !== modelId))

        // Refresh active models after starting (pass provider to get correct engine's loaded models)
        serviceHub
          .models()
          .getActiveModels(provider.provider)
          .then((models) => setActiveModels(models || []))
      } catch (error) {
        setFailedModels((prev) =>
          prev.includes(modelId) ? prev : [...prev, modelId]
        )
        // An engine failure carries a code and the engine's own words; the
        // plain text of it is only "The model could not be loaded."
        const message = parseEngineError(error)
          ? describeEngineError(error)
          : errorText(error, 'Model could not start')
        setModelLoadError(message)
        toast.error(`Could not start ${modelId}`, { description: message })
      } finally {
        // Remove model from loading state
        setLoadingModels((prev) => prev.filter((id) => id !== modelId))
      }
    }
  }

  const handleStopModel = (modelId: string) => {
    // Original: stopModel(modelId).then(() => { setActiveModels((prevModels) => prevModels.filter((model) => model !== modelId)) })
    serviceHub
      .models()
      .stopModel(modelId, provider?.provider)
      .then(() => {
        // Refresh active models after stopping (pass provider to get correct engine's loaded models)
        serviceHub
          .models()
          .getActiveModels(provider?.provider)
          .then((models) => setActiveModels(models || []))
      })
      .catch((error) => {
        console.error('Error stopping model:', error)
      })
  }

  return {
    loadingModels,
    failedModels,
    refreshingModels,
    handleRefreshModels,
    handleStartModel,
    handleStopModel,
  }
}
