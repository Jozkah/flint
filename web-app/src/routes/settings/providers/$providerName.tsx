/* eslint-disable @typescript-eslint/no-explicit-any */
import { Card, CardItem } from '@/containers/Card'
import { classifyModelLocation } from '@/lib/modelLocation'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  cn,
  formatBytes,
  getProviderTitle,
  getModelDisplayName,
  isLocalProvider,
} from '@/lib/utils'
import { sortModels } from '@/lib/modelSort'
import { createFileRoute, useParams } from '@tanstack/react-router'
import { useTranslation } from '@/i18n/react-i18next-compat'
import Capabilities from '@/containers/Capabilities'
import { DynamicControllerSetting } from '@/containers/dynamicControllerSetting'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { DialogEditModel } from '@/containers/dialogs/EditModel'
import { ImportLlamacppModelDialog } from '@/containers/dialogs/ImportLlamacppModelDialog'
import { ImportMlxModelDialog } from '@/containers/dialogs/ImportMlxModelDialog'
import { ModelSetting } from '@/containers/ModelSetting'
import { DialogDeleteModel } from '@/containers/dialogs/DeleteModel'
import { DialogDeleteAllModels } from '@/containers/dialogs/DeleteAllModels'
import { FavoriteModelAction } from '@/containers/FavoriteModelAction'
import DeleteProvider from '@/containers/dialogs/DeleteProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { Button } from '@/components/ui/button'
import { SecretInput } from '@/components/ui/secret-input'
import { ProviderCustomHeaders } from '@/containers/ProviderCustomHeaders'
import { applyCustomHeaders } from '@/lib/customHeaders'
import { Switch } from '@/components/ui/switch'
import {
  CircleCheck,
  Circle,
  FolderPlus,
  Info,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import { useDefaultEmbeddingModel } from '@/hooks/useDefaultEmbeddingModel'
import { toast } from 'sonner'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { predefinedProviders } from '@/constants/providers'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useAppState } from '@/hooks/useAppState'
import { useShallow } from 'zustand/shallow'
import { DialogAddModel } from '@/containers/dialogs/AddModel'
import {
  providerHasRemoteApiKeys,
  providerRemoteApiKeyChain,
  API_KEY_FALLBACKS_SETTING_KEY,
  serializeApiKeyFallbacks,
} from '@/lib/provider-api-keys'
import {
  describeEndpointFailure,
  isLocalEndpoint,
} from '@/lib/endpointDiagnostics'
import { errorText } from '@/lib/errorText'
import {
  deriveModelStatus,
  modelStatusLabelKey,
  modelStatusTone,
} from '@/lib/modelStatus'
import { StatusChip } from '@/containers/StatusChip'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'

// as route.threadsDetail
export const Route = createFileRoute('/settings/providers/$providerName')({
  component: ProviderDetail,
  validateSearch: (search: Record<string, unknown>): { step?: string } => {
    // validate and parse the search params into a typed state
    return {
      step: String(search?.step),
    }
  },
})

/** What the file list on disk says about one installed model. */
type LocalFileInfo = { sizeBytes?: number; fileName?: string }

/** The last path segment, on either separator. */
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

/** A model's configured context length, when it has one. */
function contextLengthOf(model: Model): number | undefined {
  const value = (model.settings as any)?.ctx_len?.controller_props?.value
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Columns of the model list once its container is wide enough. */
const LOCAL_GRID =
  '@3xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_5.5rem_6rem_10rem_auto]'
const REMOTE_GRID = '@2xl:grid-cols-[minmax(0,1fr)_10rem_auto]'

function ProviderDetail() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { setModelLoadError } = useModelLoad()
  const [activeModels, setActiveModels] = useAppState(
    useShallow((state) => [state.activeModels, state.setActiveModels])
  )
  // A load started anywhere else in the app (a chat, the API server).
  const globallyLoadingModelId = useAppState(
    (state) => state.modelLoadProgress?.modelId
  )
  const [loadingModels, setLoadingModels] = useState<string[]>([])
  /** Models whose last start from this page threw; cleared by a success. */
  const [failedModels, setFailedModels] = useState<string[]>([])
  /** A request with the saved keys succeeded while this page was open. */
  const [connectionVerified, setConnectionVerified] = useState(false)
  const [localFiles, setLocalFiles] = useState<Record<string, LocalFileInfo>>(
    {}
  )
  const [refreshingModels, setRefreshingModels] = useState(false)
  const [importingModel, setImportingModel] = useState<string | null>(null)
  const [apiKeysDraft, setApiKeysDraft] = useState('')
  const [baseUrlDraft, setBaseUrlDraft] = useState('')
  const [showAdvancedApiKeys, setShowAdvancedApiKeys] = useState(false)
  const [isTestingKeys, setIsTestingKeys] = useState(false)
  const [keyCheckResults, setKeyCheckResults] = useState<
    { index: number; masked: string; status: string; detail: string }[]
  >([])
  const { providerName } = useParams({ from: Route.id })
  const { getProviderByName, setProviders, updateProvider } =
    useModelProvider()
  const provider = getProviderByName(providerName)
  const isLlamacpp = provider?.provider === 'llamacpp'
  const isEngineProvider =
    provider?.provider === 'llamacpp' || provider?.provider === 'mlx'
  const isPredefinedProvider = useMemo(
    () => predefinedProviders.some((p) => p.provider === providerName),
    [providerName]
  )
  // Listed by the name on screen rather than the order the provider returned
  // them in, so a renamed model sits where its new name says it should.
  const allModels = useMemo(() => {
    const models = provider?.models ?? []
    if (!provider) return models
    return sortModels(
      models.map((model) => ({ model, provider })),
      'name-asc'
    ).map((item) => item.model)
  }, [provider])
  const embeddingModels = useMemo(
    () =>
      isLlamacpp
        ? allModels.filter((m) => (m as any).embedding === true)
        : [],
    [isLlamacpp, allModels]
  )
  const chatModels = useMemo(
    () =>
      isLlamacpp
        ? allModels.filter((m) => (m as any).embedding !== true)
        : allModels,
    [isLlamacpp, allModels]
  )
  const defaultEmbeddingModelId = useDefaultEmbeddingModel((s) =>
    isLlamacpp ? s.getDefault('llamacpp') : undefined
  )
  const setDefaultEmbeddingModel = useDefaultEmbeddingModel((s) => s.setDefault)
  const clearDefaultEmbeddingModel = useDefaultEmbeddingModel(
    (s) => s.clearDefault
  )

  useEffect(() => {
    if (!isLlamacpp) return
    const hasMini = allModels.some(
      (m) => m.id === 'sentence-transformer-mini'
    )
    if (
      !defaultEmbeddingModelId &&
      embeddingModels.length === 1 &&
      !hasMini
    ) {
      setDefaultEmbeddingModel('llamacpp', embeddingModels[0].id)
      return
    }
    if (
      defaultEmbeddingModelId &&
      embeddingModels.length > 0 &&
      !embeddingModels.some((m) => m.id === defaultEmbeddingModelId)
    ) {
      clearDefaultEmbeddingModel('llamacpp')
      return
    }
    if (defaultEmbeddingModelId && embeddingModels.length === 0) {
      clearDefaultEmbeddingModel('llamacpp')
    }
  }, [
    isLlamacpp,
    defaultEmbeddingModelId,
    embeddingModels,
    allModels,
    setDefaultEmbeddingModel,
    clearDefaultEmbeddingModel,
  ])


  const handleModelImportSuccess = async (importedModelName?: string) => {
    if (importedModelName) {
      setImportingModel(importedModelName)
    }

    try {
      // Refresh the provider to update the models list
      await serviceHub.providers().getProviders().then(setProviders)

      // If a model was imported and it might have vision capabilities, check and update
      if (importedModelName && providerName === 'llamacpp') {
        try {
          const mmprojExists = await serviceHub
            .models()
            .checkMmprojExists(importedModelName)
          if (mmprojExists) {
            // Get the updated provider after refresh
            const { getProviderByName, updateProvider: updateProviderState } =
              useModelProvider.getState()
            const llamacppProvider = getProviderByName('llamacpp')

            if (llamacppProvider) {
              const modelIndex = llamacppProvider.models.findIndex(
                (m: Model) => m.id === importedModelName
              )
              if (modelIndex !== -1) {
                const model = llamacppProvider.models[modelIndex]
                const capabilities = model.capabilities || []

                // Add 'vision' capability if not already present AND if user hasn't manually configured capabilities
                // Check if model has a custom capabilities config flag

                const hasUserConfiguredCapabilities =
                  (model as any)._userConfiguredCapabilities === true

                if (
                  !capabilities.includes('vision') &&
                  !hasUserConfiguredCapabilities
                ) {
                  const updatedModels = [...llamacppProvider.models]
                  updatedModels[modelIndex] = {
                    ...model,
                    capabilities: [...capabilities, 'vision'],
                    // Mark this as auto-detected, not user-configured
                    _autoDetectedVision: true,
                  } as any

                  updateProviderState('llamacpp', { models: updatedModels })
                  console.log(
                    `Vision capability added to model after provider refresh: ${importedModelName}`
                  )
                }
              }
            }
          }
        } catch (error) {
          console.error('Error checking mmproj existence after import:', error)
        }
      }
    } finally {
      // The importing state will be cleared by the useEffect when model appears in list
    }
  }

  useEffect(() => {
    // Initial data fetch - load active models for the current provider
    if (provider?.provider) {
      serviceHub
        .models()
        .getActiveModels(provider.provider)
        .then((models) => setActiveModels(models || []))
    }
  }, [serviceHub, setActiveModels, provider?.provider])

  // File name and size of installed models, for the list. Read-only, and the
  // list still renders without it.
  const modelIdsKey = (provider?.models ?? []).map((m) => m.id).join(' ')
  useEffect(() => {
    if (!isEngineProvider || !provider) {
      setLocalFiles({})
      return
    }
    const models = serviceHub.models() as Partial<
      ReturnType<typeof serviceHub.models>
    >
    if (typeof models.fetchModels !== 'function') return
    let cancelled = false
    Promise.resolve()
      .then(() => models.fetchModels!())
      .then((infos) => {
        if (cancelled) return
        const next: Record<string, LocalFileInfo> = {}
        for (const info of infos ?? []) {
          if (info.providerId !== provider.provider) continue
          next[info.id] = {
            sizeBytes: info.sizeBytes || undefined,
            fileName: info.path ? baseName(info.path) : undefined,
          }
        }
        setLocalFiles(next)
      })
      .catch(() => {
        if (!cancelled) setLocalFiles({})
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceHub, isEngineProvider, provider?.provider, modelIdsKey])

  // Clear importing state when model appears in the provider's model list
  useEffect(() => {
    if (importingModel && provider?.models) {
      const modelExists = provider.models.some(
        (model) => model.id === importingModel
      )
      if (modelExists) {
        setImportingModel(null)
      }
    }
  }, [importingModel, provider?.models])

  // Fallback: Clear importing state after 10 seconds to prevent infinite loading
  useEffect(() => {
    if (importingModel) {
      const timeoutId = setTimeout(() => {
        setImportingModel(null)
      }, 10000) // 10 seconds fallback

      return () => clearTimeout(timeoutId)
    }
  }, [importingModel])

  useEffect(() => {
    if (!provider) return
    if (provider.provider === 'llamacpp' || provider.provider === 'mlx') return
    setApiKeysDraft(providerRemoteApiKeyChain(provider).join('\n'))
    // Other keys, or another provider: an earlier success says nothing now.
    setConnectionVerified(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerName, provider?.api_key, JSON.stringify(provider?.api_key_fallbacks ?? [])])

  // The configured data folder, when this run could not use it (#8374, #8855).
  const [unavailableDataFolder, setUnavailableDataFolder] = useState<
    string | undefined
  >()
  useEffect(() => {
    let alive = true
    void Promise.resolve(serviceHub.app?.()?.getUnavailableJanDataFolder?.())
      .then((path) => {
        if (alive) setUnavailableDataFolder(path || undefined)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [serviceHub])

  useEffect(() => {
    if (provider?.provider !== 'azure') return
    setBaseUrlDraft(provider.base_url ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerName, provider?.base_url])

  const commitApiKeysDraft = useCallback(() => {
    if (!provider) return
    const lines = apiKeysDraft
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const nextPrimary = lines[0] ?? ''
    const nextFallbacks = lines.slice(1)

    const prevPrimary = provider.api_key ?? ''
    const prevFallbacks = provider.api_key_fallbacks ?? []
    const changed =
      nextPrimary !== prevPrimary ||
      JSON.stringify(nextFallbacks) !== JSON.stringify(prevFallbacks)
    if (!changed) return

    const newSettings = [...provider.settings]
    const apiKeySettingIndex = newSettings.findIndex((s) => s.key === 'api-key')
    if (apiKeySettingIndex !== -1) {
      const apiKeyProps = newSettings[apiKeySettingIndex].controller_props as {
        value: string | boolean | number
      }
      apiKeyProps.value = nextPrimary
    }

    const fallbacksValue = serializeApiKeyFallbacks(nextFallbacks)
    const fallbacksIndex = newSettings.findIndex(
      (s) => s.key === API_KEY_FALLBACKS_SETTING_KEY
    )
    if (fallbacksIndex !== -1) {
      const props = newSettings[fallbacksIndex].controller_props as {
        value: string | boolean | number
      }
      props.value = fallbacksValue
    } else if (fallbacksValue.length > 0) {
      newSettings.push({
        key: API_KEY_FALLBACKS_SETTING_KEY,
        title: 'API Key Fallbacks',
        description: '',
        controller_type: 'input',
        controller_props: {
          value: fallbacksValue,
          type: 'password',
          placeholder: '',
        },
      } as (typeof newSettings)[number])
    }

    serviceHub.providers().updateSettings(providerName, newSettings)
    updateProvider(providerName, {
      ...provider,
      settings: newSettings,
      api_key: nextPrimary,
      api_key_fallbacks: nextFallbacks,
    })
    // Clearing the key is an explicit user action: purge the keyring secret so
    // it isn't re-seeded into memory on the next launch. (register handles the
    // non-empty case via boot sync -> register_provider_config.)
    if (nextPrimary.length === 0 && nextFallbacks.length === 0) {
      serviceHub.providers().deleteProviderKeys(providerName)
    }
  }, [apiKeysDraft, provider, providerName, serviceHub, updateProvider])

  const commitBaseUrlDraft = useCallback(() => {
    if (!provider || provider.provider !== 'azure') return
    const next = baseUrlDraft.trim()
    if (next === (provider.base_url ?? '')) return
    updateProvider(providerName, { ...provider, base_url: next })
  }, [baseUrlDraft, provider, providerName, updateProvider])

  const rawApiKeyLines = apiKeysDraft.split(/\r?\n/)
  const primaryKeyDraft = (rawApiKeyLines[0] ?? '').trim()
  const setPrimaryKeyDraft = (nextPrimary: string) => {
    const rest = rawApiKeyLines.slice(1)
    setApiKeysDraft([nextPrimary, ...rest].join('\n'))
  }

  const advancedApiKeyLines = apiKeysDraft.split(/\r?\n/).map((l) => l.trim())
  const setKeyAtIndex = (index: number, nextValue: string) => {
    const next = [...advancedApiKeyLines]
    next[index] = nextValue.trim()
    setApiKeysDraft(next.join('\n'))
  }

  const addKeyLine = () => {
    setApiKeysDraft([...advancedApiKeyLines, ''].join('\n'))
  }

  const removeKeyLine = (index: number) => {
    if (index === 0) return
    const next = advancedApiKeyLines.filter((_, i) => i !== index)
    setApiKeysDraft((next.length > 0 ? next : ['']).join('\n'))
  }

  const maskApiKey = useCallback((value: string) => {
    if (value.length <= 8) return `${value.slice(0, 2)}***`
    return `${value.slice(0, 4)}***${value.slice(-4)}`
  }, [])

  const getStatusLabel = useCallback((status: string) => {
    switch (status) {
      case 'ok':
        return 'OK'
      case 'unauthorized':
        return 'Invalid / revoked key (401)'
      case 'forbidden':
        return 'Forbidden (403)'
      case 'rate_limited':
        return 'Rate limited / out of credit (429)'
      case 'network_error':
        return 'Network error'
      default:
        return 'Failed'
    }
  }, [])

  const getStatusClass = useCallback((status: string) => {
    switch (status) {
      case 'ok':
        return 'text-success'
      case 'unauthorized':
      case 'forbidden':
      case 'http_error':
      case 'network_error':
      case 'rate_limited':
        return 'text-warning'
      default:
        return 'text-destructive'
    }
  }, [])

  const handleTestApiKeys = useCallback(async () => {
    if (!provider?.base_url) {
      toast.error(t('providers:models'), {
        description: t('providers:refreshModelsError'),
      })
      return
    }

    const keyDraftLines = apiKeysDraft.split(/\r?\n/).map((l) => l.trim())
    const nonEmptyKeyCount = keyDraftLines.filter((l) => l.length > 0).length
    if (nonEmptyKeyCount === 0) {
      toast.error(t('providers:models'), {
        description: t('providers:refreshModelsError'),
      })
      return
    }

    setIsTestingKeys(true)
    try {
      const fetchImpl = serviceHub.providers().fetch()
      const results: { index: number; masked: string; status: string; detail: string }[] = []

      for (let i = 0; i < keyDraftLines.length; i++) {
        const key = keyDraftLines[i]
        const keyIndex = i + 1
        if (!key) continue
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'x-api-key': key,
          Authorization: `Bearer ${key}`,
        }
        // Loopback and LAN endpoints are local engines, not remote services.
        // The old check matched the literal strings "localhost:" and
        // "127.0.0.1:", so a server on the LAN or on a Tailscale address was
        // treated as remote.
        if (isLocalEndpoint(provider.base_url)) {
          headers['Origin'] = 'tauri://localhost'
        }
        // What a real request sends, so a gateway that needs its own header
        // does not fail the test for want of it. janhq/jan#8208.
        applyCustomHeaders(headers, provider)

        try {
          const response = await fetchImpl(`${provider.base_url}/models`, {
            method: 'GET',
            headers,
          })

          let status = 'http_error'
          if (response.ok) status = 'ok'
          else if (response.status === 401) status = 'unauthorized'
          else if (response.status === 403) status = 'forbidden'
          else if (response.status === 429) status = 'rate_limited'

          results.push({
            index: keyIndex,
            masked: maskApiKey(key),
            status,
            // Name the endpoint, the status and whoever answered. A bare
            // "Forbidden (403)" cannot tell a wrong key from a proxy on the
            // internet answering for a server the user believes is local.
            detail: response.ok
              ? `${response.status} ${response.statusText}`
              : describeEndpointFailure({
                  provider: provider.provider,
                  url: `${provider.base_url}/models`,
                  method: 'GET',
                  status: response.status,
                  statusText: response.statusText,
                  server: response.headers?.get?.('server') ?? null,
                }),
          })
        } catch (err) {
          results.push({
            index: keyIndex,
            masked: maskApiKey(key),
            status: 'network_error',
            detail: describeEndpointFailure({
              provider: provider.provider,
              url: `${provider.base_url}/models`,
              method: 'GET',
              cause: err,
            }),
          })
        }
      }

      setKeyCheckResults(results)
      if (results.some((r) => r.status === 'ok')) setConnectionVerified(true)
    } finally {
      setIsTestingKeys(false)
    }
  }, [apiKeysDraft, maskApiKey, provider, serviceHub, t])

  // Note: settingsChanged event is now handled globally in GlobalEventHandler
  // This ensures all screens receive the event intermediately

  const handleRefreshModels = async () => {
    if (!provider || !provider.base_url) {
      toast.error(t('providers:models'), {
        description: t('providers:refreshModelsError'),
      })
      return
    }
    // Only an endpoint that is *definitely* public is asked for a key up
    // front. A local one needs no credential, and a single-label hostname like
    // `llm-host` is not yet known to be either -- refusing those meant Jan told
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
      setConnectionVerified(true)
      const newModels: Model[] = modelIds.map((id) => ({
        id,
        model: id,
        name: id,
        capabilities: ['completion'],
        version: '1.0',
      }))


      const existingModelIds = provider.models.map((m) => m.id)
      const modelsToAdd = newModels.filter(
        (model) => !existingModelIds.includes(model.id)
      )

      if (modelsToAdd.length > 0) {
        const updatedModels = [...provider.models, ...modelsToAdd]
        updateProvider(providerName, {
          ...provider,
          models: updatedModels,
        })

        toast.success(t('providers:models'), {
          description: t('providers:refreshModelsSuccess', {
            count: modelsToAdd.length,
            provider: provider.provider,
          }),
        })
      } else {
        toast.success(t('providers:models'), {
          description: t('providers:noNewModels'),
        })
      }
    } catch (error) {
      console.error(
        t('providers:refreshModelsFailed', { provider: provider.provider }),
        error
      )
      // Show what actually failed. The service throws a message naming the
      // endpoint, the status and whoever answered; replacing it with "check
      // your API key and base URL" hid a proxy answering 403 for a server the
      // user believed was local, and pointed at the one thing that was fine.
      toast.error(t('providers:models'), {
        description: errorText(
          error,
          t('providers:refreshModelsFailed', { provider: provider.provider })
        ),
      })
    } finally {
      setRefreshingModels(false)
    }
  }

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
        setModelLoadError(error as ErrorObject)
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

  const apiKeyMissing =
    !!provider &&
    !isEngineProvider &&
    !!provider.base_url &&
    classifyModelLocation({ baseUrl: provider.base_url }) === 'remote' &&
    !providerHasRemoteApiKeys(provider)

  const statusFor = (modelId: string) =>
    deriveModelStatus({
      modelId,
      engineManaged: isEngineProvider,
      activeModels,
      loadingModelIds: globallyLoadingModelId
        ? [...loadingModels, globallyLoadingModelId]
        : loadingModels,
      failedModelIds: failedModels,
      apiKeyMissing,
      connectionVerified,
    })

  const renderStatus = (modelId: string) => {
    const status = statusFor(modelId)
    if (!status) return null
    return (
      <StatusChip
        tone={modelStatusTone(status)}
        pulse={status === 'loading'}
        data-testid={`model-status-${modelId}`}
        data-status={status}
      >
        {t(modelStatusLabelKey(status))}
      </StatusChip>
    )
  }

  /** One model as a row: a record on narrow screens, table columns on wide. */
  const renderModelRow = (
    model: Model,
    key: string,
    options: {
      leading?: ReactNode
      badges?: ReactNode
      actions: ReactNode
      selected?: boolean
    }
  ) => {
    const file = localFiles[model.id]
    const contextLength = contextLengthOf(model)
    const metaLabel = 'text-muted-foreground @3xl:sr-only'
    return (
      <li
        key={key}
        data-testid={`model-row-${model.id}`}
        className={cn(
          'relative grid min-h-11 grid-cols-1 gap-x-4 gap-y-2 border-b border-border px-2 py-3 last:border-b-0 @3xl:items-center',
          isEngineProvider ? LOCAL_GRID : REMOTE_GRID,
          options.selected &&
            'bg-brand-tint before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-brand'
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {options.leading}
          <span
            className="min-w-0 truncate font-medium text-foreground"
            title={model.id}
          >
            {getModelDisplayName(model)}
          </span>
          {/* A renamed model still answers to its own identifier, which is
              what requests carry. */}
          {model.displayName && model.displayName !== model.id && (
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {model.id}
            </span>
          )}
          <Capabilities capabilities={model.capabilities || []} />
          {options.badges}
          {model.imported && (
            <span
              className="shrink-0 rounded-sm bg-sunken px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-2"
              title={t('providers:importedTooltip')}
            >
              {t('providers:imported')}
            </span>
          )}
        </div>
        {isEngineProvider && (
          <dl className="contents text-sm">
            <div className="flex min-w-0 items-baseline justify-between gap-3 @3xl:block">
              <dt className={metaLabel}>{t('providers:table.file')}</dt>
              <dd
                className="min-w-0 truncate font-mono text-xs text-ink-2"
                title={file?.fileName}
              >
                {file?.fileName ?? '—'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 @3xl:block">
              <dt className={metaLabel}>{t('providers:table.size')}</dt>
              <dd className="tabular-nums text-ink-2">
                {file?.sizeBytes ? formatBytes(file.sizeBytes) : '—'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 @3xl:block">
              <dt className={metaLabel}>{t('providers:table.context')}</dt>
              <dd className="tabular-nums text-ink-2">
                {contextLength ? contextLength.toLocaleString() : '—'}
              </dd>
            </div>
          </dl>
        )}
        <div className="flex min-w-0 items-center">{renderStatus(model.id)}</div>
        <div className="flex flex-wrap items-center justify-start gap-1 @2xl:justify-end">
          {options.actions}
        </div>
      </li>
    )
  }

  /** Column labels, shown only once the rows lay out as a table. */
  const renderListHeader = () => (
    <div
      aria-hidden
      className={cn(
        'hidden gap-x-4 border-b border-border px-2 pb-2 text-xs font-medium text-muted-foreground',
        isEngineProvider ? `@3xl:grid ${LOCAL_GRID}` : `@2xl:grid ${REMOTE_GRID}`
      )}
    >
      <span>{t('providers:table.name')}</span>
      {isEngineProvider && (
        <>
          <span>{t('providers:table.file')}</span>
          <span>{t('providers:table.size')}</span>
          <span>{t('providers:table.context')}</span>
        </>
      )}
      <span>{t('providers:table.status')}</span>
      <span className="text-right">{t('providers:table.actions')}</span>
    </div>
  )

  const sectionDivider = (label: string, className?: string) => (
    <div
      role="separator"
      aria-label={label}
      className={cn('flex items-center gap-3', className)}
    >
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )

  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader />
      <SettingsPageBody>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h2 className="min-w-0 truncate font-display text-2xl font-normal text-foreground">
            {getProviderTitle(providerName)}
          </h2>
          <Switch
            aria-label={t('providers:useProvider', {
              provider: getProviderTitle(providerName),
            })}
            checked={provider?.active ?? false}
            onCheckedChange={(checked) => provider && updateProvider(providerName, { active: checked })}
          />
        </div>

        {provider &&
          !isLocalProvider(provider.provider) && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-sunken px-3 py-2 text-xs text-ink-2">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {t('providers:limitedSupport', {
                  defaultValue:
                    'This provider may not be fully supported. Capabilities (tools, vision, audio) are not auto-detected - add models manually and configure capabilities per model.',
                })}
              </span>
            </div>
          )}

        {provider?.provider === 'mlx' && (
          <div className="flex items-start gap-2 rounded-md border border-border bg-warning-tint px-3 py-2 text-xs text-ink-2">
            <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <span>
              {t('providers:mlxExperimental', {
                defaultValue:
                  'MLX support is experimental. Embeddings are unavailable, the reasoning toggle is not yet wired through, and some newer model architectures may fail to load. Report issues on GitHub so we can prioritize them.',
              })}
            </span>
          </div>
        )}

        <div
          className={cn(
            'flex flex-col gap-4',
            provider &&
              (provider.provider === 'llamacpp' ||
                provider.provider === 'mlx') &&
              'flex-col-reverse'
          )}
        >
          {/* Settings — hidden for predefined remote providers since
              api-key + base-url are both surfaced elsewhere / hidden. */}
          {!(
            isPredefinedProvider &&
            provider?.provider !== 'llamacpp' &&
            provider?.provider !== 'mlx'
          ) && (
          <Card>
            {provider?.settings.map((setting, settingIndex) => {
              if (
                setting.key === 'api-key' &&
                provider?.provider !== 'llamacpp' &&
                provider?.provider !== 'mlx'
              ) {
                return null
              }

              if (
                provider?.provider === 'llamacpp' &&
                setting.key === 'fit_ctx'
              ) {
                return null
              }

              // Use the DynamicController component
              const actionComponent = (
                <div className="mt-1 sm:mt-0">
                  <DynamicControllerSetting
                      controllerType={setting.controller_type}
                      controllerProps={setting.controller_props}
                      className={cn(setting.key === 'device' && 'hidden')}
                      onChange={(newValue) => {
                        if (provider) {
                          const newSettings = [...provider.settings]
                          // Handle different value types by forcing the type
                          // Use type assertion to bypass type checking

                          ;(
                            newSettings[settingIndex].controller_props as {
                              value: string | boolean | number
                            }
                          ).value = newValue

                          // Create update object with updated settings
                          const updateObj: Partial<ModelProvider> = {
                            settings: newSettings,
                          }
                          // Check if this is an API key or base URL setting and update the corresponding top-level field
                          const settingKey = setting.key
                          if (
                            settingKey === 'api-key' &&
                            typeof newValue === 'string'
                          ) {
                            updateObj.api_key = newValue
                          } else if (
                            settingKey === 'base-url' &&
                            typeof newValue === 'string'
                          ) {
                            updateObj.base_url = newValue
                          }

                          serviceHub
                            .providers()
                            .updateSettings(
                              providerName,
                              updateObj.settings ?? []
                            )
                          updateProvider(providerName, {
                            ...provider,
                            ...updateObj,
                          })

                          serviceHub.models().stopAllModels()

                          // Refresh active models after stopping
                          serviceHub
                            .models()
                            .getActiveModels()
                            .then((models) => setActiveModels(models || []))
                        }
                      }}
                    />
                </div>
              )

              return (
                <CardItem
                  key={settingIndex}
                  title={setting.title}
                  className={cn(setting.key === 'device' && 'hidden')}
                  column={
                    setting.controller_type === 'input' &&
                    setting.controller_props.type !== 'number'
                      ? true
                      : false
                  }
                  description={
                    <>
                      <RenderMarkdown
                        className="![>p]:text-muted-foreground select-none"
                        content={setting.description}
                        components={{
                          // Make links open in a new tab
                          a: ({ ...props }) => {
                            return (
                              <a
                                {...props}
                                className="text-brand-text underline-offset-4 hover:underline"
                                target="_blank"
                                rel="noopener noreferrer"
                              />
                            )
                          },
                          p: ({ ...props }) => (
                            <p {...props} className="mb-0!" />
                          ),
                        }}
                      />
                    </>
                  }
                  actions={actionComponent}
                />
              )
            })}

            <DeleteProvider provider={provider} />
          </Card>
          )}

          {provider &&
            provider.provider !== 'llamacpp' &&
            provider.provider !== 'mlx' && (
              <Card>
                {provider.provider === 'azure' && (
                  <div className="mb-5 space-y-2">
                    <div className="space-y-1">
                      <h3 className="font-display text-lg font-normal text-foreground">
                        {t('providers:baseUrl.title')}
                      </h3>
                      <p className="text-sm leading-normal text-muted-foreground">
                        {t('providers:baseUrl.azureDescription')}
                      </p>
                    </div>
                    <input
                      className="flex h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 font-mono text-base text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11 md:text-sm"
                      placeholder="https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1"
                      value={baseUrlDraft}
                      onChange={(e) => setBaseUrlDraft(e.target.value)}
                      onBlur={() => commitBaseUrlDraft()}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </div>
                )}
                <div className="space-y-3">
                  <div className="space-y-1">
                    <h3 className="font-display text-lg font-normal text-foreground">
                      {t('providers:apiKeys.title')}
                    </h3>
                    <p className="text-sm leading-normal text-muted-foreground">
                      {t('providers:apiKeys.description')}
                    </p>
                  </div>
                  {!showAdvancedApiKeys && (
                    <div className="flex flex-col gap-2">
                      <SecretInput
                        className="font-mono"
                        placeholder={t('providers:apiKeys.primaryPlaceholder')}
                        value={primaryKeyDraft}
                        onChange={(e) => setPrimaryKeyDraft(e.target.value)}
                        onBlur={() => commitApiKeysDraft()}
                        spellCheck={false}
                        autoComplete="off"
                      />

                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="pointer-coarse:h-11"
                          onClick={() => {
                            setShowAdvancedApiKeys(true)
                            setKeyCheckResults([])
                          }}
                        >
                          {t('providers:apiKeys.advanced')}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          {t('providers:apiKeys.oneKeyHint')}
                        </span>
                      </div>
                    </div>
                  )}

                  {showAdvancedApiKeys && (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs text-muted-foreground">
                          {t('providers:apiKeys.testHint')}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="pointer-coarse:h-11"
                            onClick={() => {
                              commitApiKeysDraft()
                              setShowAdvancedApiKeys(false)
                              setKeyCheckResults([])
                            }}
                          >
                            {t('providers:apiKeys.hideAdvanced')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="pointer-coarse:h-11"
                            onClick={handleTestApiKeys}
                            disabled={isTestingKeys}
                          >
                            {isTestingKeys ? (
                              <>
                                <LoaderCircle
                                  className="animate-spin"
                                  aria-hidden
                                />
                                {t('providers:apiKeys.testing')}
                              </>
                            ) : (
                              t('providers:apiKeys.test')
                            )}
                          </Button>
                        </div>
                      </div>

                      <div className="text-xs text-muted-foreground">
                        Primary key is <span className="font-medium">#1</span>. Jan
                        retries the next key only on{' '}
                        <span className="font-mono">401/403/429</span>.
                      </div>

                      <div className="space-y-2">
                        {advancedApiKeyLines.map((keyValue, idx) => {
                          const keyIndex = idx + 1
                          const rowResult = keyCheckResults.find(
                            (r) => r.index === keyIndex
                          )

                          return (
                            <div
                              key={idx}
                              className="grid grid-cols-[2.5rem_minmax(0,1fr)_2.75rem] items-center gap-x-2 gap-y-1"
                            >
                              <div className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                                #{keyIndex}
                              </div>

                              <div className="min-w-0">
                                <SecretInput
                                  className="font-mono w-full"
                                  placeholder={t('providers:apiKeys.keyPlaceholder')}
                                  value={keyValue}
                                  onChange={(e) => {
                                    setKeyAtIndex(idx, e.target.value)
                                  }}
                                  onBlur={commitApiKeysDraft}
                                  spellCheck={false}
                                  autoComplete="off"
                                />
                              </div>

                              <div className="flex justify-end">
                                {idx !== 0 ? (
                                  <Button
                                    size="icon-sm"
                                    variant="outline"
                                    className="pointer-coarse:size-11"
                                    onClick={() => {
                                      setKeyCheckResults([])
                                      removeKeyLine(idx)
                                    }}
                                    title={t('providers:apiKeys.removeKey')}
                                  >
                                    -
                                  </Button>
                                ) : (
                                  <span aria-hidden>&nbsp;</span>
                                )}
                              </div>

                              <div aria-hidden />
                              <div className="min-w-0">
                                {rowResult && (
                                  <div
                                    className={cn(
                                      'text-right text-xs font-medium',
                                      getStatusClass(rowResult.status)
                                    )}
                                    title={rowResult.detail}
                                  >
                                    {getStatusLabel(rowResult.status)}
                                  </div>
                                )}
                              </div>
                              <div aria-hidden />
                            </div>
                          )
                        })}

                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="pointer-coarse:h-11"
                            onClick={() => {
                              setKeyCheckResults([])
                              addKeyLine()
                            }}
                          >
                            + {t('providers:apiKeys.addKey')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <ProviderCustomHeaders provider={provider} />
              </Card>
            )}

          {/* janhq/jan#8374. A local model list read from the default data
              folder because the configured one could not be used is not
              an empty library: say so here, where the models are missing,
              not only in Settings > General. */}
          {unavailableDataFolder &&
            (provider?.provider === 'llamacpp' || provider?.provider === 'mlx') && (
              <p
                role="alert"
                data-testid="data-folder-unavailable-notice"
                className="rounded-md border border-destructive/40 bg-destructive-tint px-3 py-2 text-xs text-destructive"
              >
                {t('providers:dataFolderUnavailable', {
                  path: unavailableDataFolder,
                })}
              </p>
            )}
          {/* Models */}
          <Card
            header={
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-xl font-normal text-foreground">
                  {t('providers:models')}
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  {provider && provider.provider !== 'llamacpp' && provider.provider !== 'mlx' && (
                    <>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        className="pointer-coarse:size-11"
                        onClick={handleRefreshModels}
                        disabled={refreshingModels}
                        // Icon-only: without a name a screen reader
                        // announces nothing but "button".
                        aria-label={
                          refreshingModels
                            ? t('providers:refreshing')
                            : t('providers:refresh')
                        }
                        title={t('providers:refresh')}
                      >
                        {refreshingModels ? (
                          <LoaderCircle
                            className="animate-spin text-muted-foreground"
                            aria-hidden
                          />
                        ) : (
                          <RefreshCw
                            className="text-muted-foreground"
                            aria-hidden
                          />
                        )}
                      </Button>
                      <DialogAddModel provider={provider} />
                    </>
                  )}
                  {provider &&
                    (provider.provider === 'llamacpp' ||
                      provider.provider === 'mlx') && (
                      <DialogDeleteAllModels provider={provider} />
                    )}
                  {provider && provider.provider === 'llamacpp' && (
                    <ImportLlamacppModelDialog
                      provider={provider}
                      onSuccess={handleModelImportSuccess}
                      trigger={
                        <Button
                          variant="default"
                          size="sm"
                          className="pointer-coarse:h-11"
                        >
                          <FolderPlus aria-hidden />
                          <span>
                            {t('providers:import')}
                          </span>
                        </Button>
                      }
                    />
                  )}
                  {provider && provider.provider === 'mlx' && (
                      <ImportMlxModelDialog
                        provider={provider}
                        onSuccess={handleModelImportSuccess}
                        trigger={
                          <Button
                            variant="default"
                            size="sm"
                            className="pointer-coarse:h-11"
                          >
                            <FolderPlus aria-hidden />
                            <span>{t('providers:import')}</span>
                          </Button>
                        }
                      />
                    )}
                </div>
              </div>
            }
          >
            <div className="@container min-w-0">
              {provider?.models.length ? (
                <>
                {isLlamacpp && embeddingModels.length > 0 && chatModels.length > 0 &&
                  sectionDivider(t('providers:chatModels'), 'mt-1 mb-3')}
                {renderListHeader()}
                <ul className="flex flex-col">
                {(isLlamacpp ? chatModels : allModels).map((model, modelIndex) => {
                  const isActive = activeModels.some(
                    (activeModel) => activeModel === model.id
                  )
                  return renderModelRow(model, String(modelIndex), {
                    actions: (
                      <>
                        {provider &&
                          (provider.provider === 'llamacpp' ||
                            provider.provider === 'mlx') && (
                            <span className="mr-1">
                              {isActive ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="pointer-coarse:h-11"
                                  onClick={() => handleStopModel(model.id)}
                                >
                                  {t('providers:stop')}
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  className="min-w-16 pointer-coarse:h-11"
                                  disabled={loadingModels.includes(
                                    model.id
                                  )}
                                  onClick={() => handleStartModel(model.id)}
                                >
                                  {loadingModels.includes(model.id) ? (
                                    <LoaderCircle
                                      className="animate-spin"
                                      aria-label={t('providers:status.loading')}
                                    />
                                  ) : (
                                    t('providers:start')
                                  )}
                                </Button>
                              )}
                            </span>
                          )}
                        {model.settings && provider &&
                          provider.provider === 'llamacpp' && (
                          <ModelSetting provider={provider} model={model} />
                        )}
                        <DialogEditModel
                          provider={provider}
                          modelId={model.id}
                        />
                        {((provider &&
                          !predefinedProviders.some(
                            (p) => p.provider === provider.provider
                          )) ||
                          (provider &&
                            predefinedProviders.some(
                              (p) => p.provider === provider.provider
                            ) &&
                            providerHasRemoteApiKeys(provider))) && (
                          <FavoriteModelAction model={model} />
                        )}
                        <DialogDeleteModel
                          provider={provider}
                          modelId={model.id}
                        />
                      </>
                    ),
                  })
                })}
                </ul>
                </>
              ) : (
                <div className="rounded-md border border-dashed border-line-strong bg-sunken/50 px-4 py-6 text-center">
                  <h3 className="font-medium text-foreground">
                    {t('providers:noModelFound')}
                  </h3>
                  <p className="mx-auto mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">
                    {provider && !isLocalProvider(provider.provider)
                      ? t('providers:noModelFoundRemoteDesc')
                      : t('providers:noModelFoundDesc')}
                  </p>
                </div>
              )}
              {/* Show importing skeleton first if there's one */}
              {importingModel && (
                <div
                  key="importing-skeleton"
                  role="status"
                  className="flex min-h-11 items-center gap-2 border-t border-border px-2 py-3"
                >
                  <StatusChip tone="progress" pulse>
                    Importing...
                  </StatusChip>
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {importingModel}
                  </span>
                </div>
              )}

              {isLlamacpp && provider && embeddingModels.length > 0 && (
                <>
                  {sectionDivider(t('providers:embeddingModels'), 'mt-6 mb-3')}
                  {renderListHeader()}
                  <ul className="flex flex-col">
                  {embeddingModels.map((model, modelIndex) => {
                    const isDefault = defaultEmbeddingModelId === model.id
                    return renderModelRow(model, `embedding-${modelIndex}`, {
                      selected: isDefault,
                      leading: (
                        <button
                          type="button"
                          onClick={() =>
                            setDefaultEmbeddingModel(
                              'llamacpp',
                              model.id
                            )
                          }
                          aria-label={
                            isDefault
                              ? t('providers:embeddingModelIsDefault')
                              : t('providers:embeddingModelSetDefault')
                          }
                          aria-pressed={isDefault}
                          title={
                            isDefault
                              ? t('providers:embeddingModelIsDefault')
                              : t('providers:embeddingModelSetDefault')
                          }
                          className="grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-sunken focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
                        >
                          {isDefault ? (
                            <CircleCheck
                              className="size-4.5 text-brand-text"
                              aria-hidden
                            />
                          ) : (
                            <Circle
                              className="size-4.5 text-muted-foreground"
                              aria-hidden
                            />
                          )}
                        </button>
                      ),
                      badges: isDefault && (
                        <span className="shrink-0 rounded-sm bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground">
                          {t('providers:embeddingModelDefault')}
                        </span>
                      ),
                      actions: (
                        <>
                          {model.settings && (
                            <ModelSetting
                              provider={provider}
                              model={model}
                            />
                          )}
                          <DialogEditModel
                            provider={provider}
                            modelId={model.id}
                          />
                          <DialogDeleteModel
                            provider={provider}
                            modelId={model.id}
                          />
                        </>
                      ),
                    })
                  })}
                  </ul>
                </>
              )}
            </div>
          </Card>
        </div>
      </SettingsPageBody>
    </div>
  )
}
