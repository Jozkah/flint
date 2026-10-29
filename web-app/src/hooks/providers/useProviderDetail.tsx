import {
  MODEL_FILTER_MIN,
  baseName,
  contextLengthOf,
  CHIP_TONE,
} from './providerDetailShared'
/* eslint-disable @typescript-eslint/no-explicit-any */
import { classifyModelLocation, endpointHost } from '@/lib/modelLocation'
import { useProviderLocations } from '@/hooks/useEndpointLocations'
import { endpointScope } from '@/lib/endpointDiagnostics'
import { providerKeyStatus } from '@/lib/providerKeyStatus'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getModelDisplayName } from '@/lib/utils'
import { sortModels } from '@/lib/modelSort'
import { groupModelsByFamily } from '@/lib/modelGroups'
import { useModelLibrary } from '@/hooks/useModelLibrary'
import { useParams } from '@tanstack/react-router'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useDefaultEmbeddingModel } from '@/hooks/useDefaultEmbeddingModel'
import { toast } from 'sonner'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { predefinedProviders } from '@/constants/providers'
import { useApiKeyDrafts } from '@/hooks/useApiKeyDrafts'
import { useProviderConnectionTest } from '@/hooks/useProviderConnectionTest'
import { useProviderModelActions } from '@/hooks/useProviderModelActions'
import { useAppState } from '@/hooks/useAppState'
import { useShallow } from 'zustand/shallow'
import { useBedrockCredentials } from '@/hooks/useBedrockCredentials'
import { providerHasRemoteApiKeys, providerRemoteApiKeyChain } from '@/lib/provider-api-keys'
import {
  deriveModelStatus,
  modelStatusLabelKey,
  modelStatusTone,
} from '@/lib/modelStatus'
import { Chip } from '@/components/ui/chip'
import { disambiguateModels } from '@/lib/modelDisplayName'
import { type LocalFileInfo, MODEL_PAGE_SIZE } from '@/containers/providers/providerTable'
import { useEngineActivity } from '@/stores/engine-activity-store'
import { useProviderFrames } from '@/hooks/providers/useProviderFrames'



export function useProviderDetail() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [activeModels, setActiveModels] = useAppState(
    useShallow((state) => [state.activeModels, state.setActiveModels])
  )
  // A load started anywhere else in the app (a chat, the API server).
  const globallyLoadingModelId = useAppState(
    (state) => state.modelLoadProgress?.modelId
  )
  const generations = useEngineActivity((s) => s.generations)
  /** A request with the saved keys succeeded while this page was open. */
  const [connectionVerified, setConnectionVerified] = useState(false)
  // The last model refresh was refused or unreachable: "Connected" would be a
  // claim about a key that has just been shown not to work.
  const [connectionFailed, setConnectionFailed] = useState(false)
  const [localFiles, setLocalFiles] = useState<Record<string, LocalFileInfo>>(
    {}
  )
  const [importingModel, setImportingModel] = useState<string | null>(null)
  const { providerName } = useParams({ from: '/settings/providers/$providerName' })
  const { getProviderByName, setProviders, updateProvider } =
    useModelProvider()
  const provider = getProviderByName(providerName)
  const isLlamacpp = provider?.provider === 'llamacpp'
  const isEngineProvider =
    provider?.provider === 'llamacpp' || provider?.provider === 'mlx'
  // Where this provider's requests go, decided the way the chat details decide
  // it, so a LAN server is not "remote" here and "on this device" there (T7-115).
  const locateProvider = useProviderLocations(
    provider ? [provider] : [],
    (name) => name === 'llamacpp' || name === 'mlx'
  )
  const providerLocation = provider ? locateProvider(provider) : 'unknown'
  // A host the resolver has not learned stays "checking" until something
  // connects to it. Say plainly it is unconfirmed after a few seconds, rather
  // than leaving a line that reads as in progress forever.
  const [reachGaveUp, setReachGaveUp] = useState(false)
  useEffect(() => {
    setReachGaveUp(false)
    if (providerLocation === 'local' || providerLocation === 'remote') return
    const timer = setTimeout(() => setReachGaveUp(true), 8000)
    return () => clearTimeout(timer)
  }, [providerLocation, provider?.base_url])
  const reachNote = isEngineProvider
    ? t('engine:providers.onDevice')
    : providerLocation === 'local'
      ? endpointScope(provider?.base_url) === 'loopback'
        ? t('engine:providers.onDevice')
        : t('engine:provider.networkNote', { host: endpointHost(provider?.base_url) ?? '' })
      : providerLocation === 'remote'
        ? t('engine:provider.remoteNote')
        : reachGaveUp
          ? t('engine:provider.reachUnconfirmedNote')
          : t('engine:provider.reachUnknownNote')
  // An engine setting change restarts that engine's models, once typing
  // pauses; a remote provider's settings never touch loaded local models.
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRestartRef = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      // Leaving the page still applies a pending restart.
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
      pendingRestartRef.current?.()
    },
    []
  )
  const stopProviderModels = useCallback(
    async (name: string) => {
      const loaded = await serviceHub.models().getActiveModels(name)
      await Promise.all(
        loaded.map((model) => serviceHub.models().stopModel(model, name))
      )
      setActiveModels((await serviceHub.models().getActiveModels()) || [])
    },
    [serviceHub, setActiveModels]
  )
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
  // Rows whose names are near-identical get a short label from what differs.
  const disambiguation = useMemo(
    () =>
      disambiguateModels(
        allModels.map((model) => ({
          key: model.id,
          name: getModelDisplayName(model),
          fileName: localFiles[model.id]?.fileName ?? model.id,
          sizeBytes: localFiles[model.id]?.sizeBytes,
          contextLength: contextLengthOf(model),
        }))
      ),
    [allModels, localFiles]
  )
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
  // A hosted provider can list hundreds of models, so past a threshold the
  // list gets a filter box and renders in pages instead of all at once.
  // The query is kept per provider, so leaving the page and coming back does
  // not wipe it.
  const modelQuery = useModelLibrary((s) => s.filterQuery[providerName] ?? '')
  const setStoredQuery = useModelLibrary((s) => s.setFilterQuery)
  const setModelQuery = useCallback(
    (query: string) => setStoredQuery(providerName, query),
    [setStoredQuery, providerName]
  )
  const expandedGroups = useModelLibrary((s) => s.expandedGroups[providerName])
  const toggleGroup = useModelLibrary((s) => s.toggleGroup)
  const [modelLimit, setModelLimit] = useState(MODEL_PAGE_SIZE)
  const canFilterModels = allModels.length > MODEL_FILTER_MIN
  const filteredModels = useMemo(() => {
    const words = modelQuery.toLowerCase().split(/\s+/).filter(Boolean)
    if (!canFilterModels || words.length === 0) return allModels
    return allModels.filter((m) => {
      const hay = `${m.id} ${m.name ?? ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [allModels, canFilterModels, modelQuery])
  useEffect(() => setModelLimit(MODEL_PAGE_SIZE), [modelQuery, providerName])
  // A long local list is grouped by model family, collapsed until opened. A
  // filter in use opens every group so the matches are visible.
  const listedModels = useMemo(
    () =>
      isLlamacpp
        ? filteredModels.filter((m) => (m as any).embedding !== true)
        : filteredModels.slice(0, modelLimit),
    [isLlamacpp, filteredModels, modelLimit]
  )
  const groupModels = isEngineProvider && canFilterModels
  const modelEntries = useMemo(() => {
    type Entry =
      | { kind: 'model'; model: (typeof listedModels)[number] }
      | { kind: 'group'; family: string; count: number; open: boolean }
    if (!groupModels) {
      return listedModels.map((model): Entry => ({ kind: 'model', model }))
    }
    const entries: Entry[] = []
    for (const group of groupModelsByFamily(listedModels)) {
      const open =
        modelQuery.trim() !== '' || !!expandedGroups?.includes(group.family)
      entries.push({
        kind: 'group',
        family: group.family,
        count: group.models.length,
        open,
      })
      if (open) {
        for (const model of group.models) entries.push({ kind: 'model', model })
      }
    }
    return entries
  }, [groupModels, listedModels, modelQuery, expandedGroups])
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
  const modelIdsKey = (provider?.models ?? []).map((m) => m.id).join('\u0000')
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
            path: info.path || undefined,
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

  // Reveals the model file in the OS file manager. The containing folder is
  // the allowed root: imported models can live outside the data folder.
  const handleRevealModelFile = useCallback(
    async (filePath: string) => {
      try {
        const dir = filePath.slice(
          0,
          Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
        )
        await serviceHub.opener().revealItemInDir(filePath, dir ? [dir] : [])
      } catch (error) {
        console.error('Failed to reveal model file:', error)
        toast.error(t('providers:revealModelFileFailed'))
      }
    },
    [serviceHub, t]
  )

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
    setConnectionFailed(false)
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

  const {
    apiKeysDraft,
    setApiKeysDraft,
    baseUrlDraft,
    setBaseUrlDraft,
    apiVersionDraft,
    setApiVersionDraft,
    showAdvancedApiKeys,
    setShowAdvancedApiKeys,
    commitApiKeysDraft,
    commitApiVersionDraft,
    commitBaseUrlDraft,
    primaryKeyDraft,
    setPrimaryKeyDraft,
    advancedApiKeyLines,
    setKeyAtIndex,
    addKeyLine,
    removeKeyLine,
  } = useApiKeyDrafts({ provider, providerName, serviceHub, updateProvider })

  const markConnectionVerified = useCallback(() => {
    setConnectionVerified(true)
    setConnectionFailed(false)
  }, [])

  const {
    isTestingKeys,
    keyCheckResults,
    setKeyCheckResults,
    handleTestApiKeys,
  } =
    useProviderConnectionTest({
      provider,
      apiKeysDraft,
      serviceHub,
      onVerified: markConnectionVerified,
    })

  // Note: settingsChanged event is now handled globally in GlobalEventHandler
  // This ensures all screens receive the event intermediately

  const {
    loadingModels,
    failedModels,
    refreshingModels,
    handleRefreshModels,
    handleStartModel,
    handleStopModel,
  } = useProviderModelActions({
    provider,
    providerName,
    serviceHub,
    updateProvider,
    onConnection: (verified) => {
      setConnectionVerified(verified)
      setConnectionFailed(!verified)
    },
  })

  const bedrockCredentialsSaved = useBedrockCredentials((state) => state.saved)
  const apiKeyMissing =
    !!provider &&
    !isEngineProvider &&
    !!provider.base_url &&
    classifyModelLocation({ baseUrl: provider.base_url }) === 'remote' &&
    (provider.provider === 'bedrock'
      ? !bedrockCredentialsSaved
      : !providerHasRemoteApiKeys(provider))

  const headerKeyStatus = provider
    ? providerKeyStatus(provider, { bedrockCredentials: bedrockCredentialsSaved })
    : undefined

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
      <Chip
        tone={CHIP_TONE[modelStatusTone(status)]}
        dot
        live={status === 'loading' || status === 'loaded'}
        data-testid={`model-status-${modelId}`}
        data-status={status}
        // A narrow column ends the label in an ellipsis (C099).
        className="min-w-0 max-w-full shrink"
        title={t(modelStatusLabelKey(status, provider?.provider))}
      >
        <span className="min-w-0 truncate">
          {t(modelStatusLabelKey(status, provider?.provider))}
        </span>
      </Chip>
    )
  }
  const {
    title,
    detailTabs,
    activeTab,
    setDetailTab,
    loadedHere,
    diskBytes,
    repliesToday,
    providerSamples,
    keyCount,
    averageSpeed,
    modelsFrame,
    note,
    speedFrame,
    settingsFrames,
    apiFrame,
    dangerFrame,
  } = useProviderFrames({
    isEngineProvider,
    provider,
    activeModels,
    localFiles,
    disambiguation,
    t,
    renderStatus,
    providerName,
    generations,
    isPredefinedProvider,
    serviceHub,
    updateProvider,
    restartTimerRef,
    pendingRestartRef,
    stopProviderModels,
    handleRefreshModels,
    refreshingModels,
    handleModelImportSuccess,
    canFilterModels,
    modelQuery,
    setModelQuery,
    allModels,
    filteredModels,
    isLlamacpp,
    embeddingModels,
    chatModels,
    modelEntries,
    toggleGroup,
    handleStopModel,
    loadingModels,
    handleStartModel,
    handleRevealModelFile,
    defaultEmbeddingModelId,
    setDefaultEmbeddingModel,
    modelLimit,
    setModelLimit,
    importingModel,
    baseUrlDraft,
    setBaseUrlDraft,
    commitBaseUrlDraft,
    apiVersionDraft,
    setApiVersionDraft,
    commitApiVersionDraft,
    showAdvancedApiKeys,
    primaryKeyDraft,
    setPrimaryKeyDraft,
    commitApiKeysDraft,
    setShowAdvancedApiKeys,
    setKeyCheckResults,
    handleTestApiKeys,
    isTestingKeys,
    advancedApiKeyLines,
    keyCheckResults,
    setKeyAtIndex,
    removeKeyLine,
    addKeyLine,
  })
  return {
    title,
    providerName,
    provider,
    isEngineProvider,
    apiKeyMissing,
    headerKeyStatus,
    connectionFailed,
    connectionVerified,
    reachNote,
    stopProviderModels,
    updateProvider,
    detailTabs,
    activeTab,
    setDetailTab,
    chatModels,
    embeddingModels,
    loadedHere,
    diskBytes,
    localFiles,
    allModels,
    repliesToday,
    providerSamples,
    keyCount,
    averageSpeed,
    unavailableDataFolder,
    t,
    modelsFrame,
    note,
    speedFrame,
    isLlamacpp,
    settingsFrames,
    apiFrame,
    dangerFrame,
  }
}
