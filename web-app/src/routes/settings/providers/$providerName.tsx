/* eslint-disable @typescript-eslint/no-explicit-any */
import { CardItem } from '@/containers/Card'
import { classifyModelLocation, endpointHost } from '@/lib/modelLocation'
import { useProviderLocations } from '@/hooks/useEndpointLocations'
import { endpointScope } from '@/lib/endpointDiagnostics'
import { providerKeyStatus } from '@/lib/providerKeyStatus'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  cn,
  formatBytes,
  getProviderTitle,
  getModelDisplayName,
  isLocalProvider,
} from '@/lib/utils'
import { sortModels } from '@/lib/modelSort'
import { groupModelsByFamily } from '@/lib/modelGroups'
import { useModelLibrary } from '@/hooks/useModelLibrary'
import { createFileRoute, Link, useParams } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { DynamicControllerSetting } from '@/containers/dynamicControllerSetting'
import {
  CONTEXT_SIZE_MIN,
  CONTEXT_SIZE_STEPS,
} from '@/lib/steppedValue'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { LlamacppEngineInfo } from '@/containers/LlamacppEngineInfo'
import { SkippedLinkedModelsNotice } from '@/containers/SkippedLinkedModelsNotice'
import DeleteProvider from '@/containers/dialogs/DeleteProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { Button } from '@/components/ui/button'
import {
  SubscriptionConnect,
  isSubscriptionProvider,
} from '@/containers/SubscriptionConnect'
import { SecretInput } from '@/components/ui/secret-input'
import { BedrockCredentials } from '@/containers/BedrockCredentials'
import { ProviderCustomHeaders } from '@/containers/ProviderCustomHeaders'
import { ProviderTlsTrust } from '@/containers/ProviderTlsTrust'
import {
  ChevronDown,
  Info,
  LoaderCircle,
  } from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { useDefaultEmbeddingModel } from '@/hooks/useDefaultEmbeddingModel'
import { toast } from 'sonner'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { predefinedProviders } from '@/constants/providers'
import { useApiKeyDrafts } from '@/hooks/useApiKeyDrafts'
import { useProviderConnectionTest } from '@/hooks/useProviderConnectionTest'
import { useProviderModelActions } from '@/hooks/useProviderModelActions'
import { EDITABLE_ENDPOINT } from '@/lib/providerDetailHelpers'
import { useAppState } from '@/hooks/useAppState'
import { useShallow } from 'zustand/shallow'
import { useBedrockCredentials } from '@/hooks/useBedrockCredentials'
import { providerHasRemoteApiKeys, providerRemoteApiKeyChain } from '@/lib/provider-api-keys'
import { errorText } from '@/lib/errorText'
import {
  deriveModelStatus,
  modelStatusLabelKey,
  modelStatusTone,
} from '@/lib/modelStatus'
import {
  SettingsPageHeader,
  SettingsWithSections,
} from '@/containers/SettingsPageHeader'
import { Chip } from '@/components/ui/chip'
import { MiddleText } from '@/components/ui/middle-text'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ENGINE_SETTINGS_WITH_INFO,
  localizeEngineSetting,
} from '@/lib/engineSettingsText'
import { disambiguateModels, parseModelName } from '@/lib/modelDisplayName'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { EngineAddonFrame } from '@/containers/EngineAddon'
import {
  CapabilityChips,
  EnginePage,
  TBOX_ROW,
  } from '@/containers/engine/EngineKit'
import { BrandMark } from '@/containers/engine/BrandMark'
import { ProviderHero } from '@/containers/providers/ProviderHero'
import { ProviderModelsFrame } from '@/containers/providers/ProviderModelsFrame'
import { type LocalFileInfo, MODEL_PAGE_SIZE } from '@/containers/providers/providerTable'
import { ProviderKpiRow } from '@/containers/providers/ProviderKpiRow'
import { LiveChart } from '@/containers/engine/LiveChart'
import { modelLogo } from '@/lib/brandLogos'
import { effectiveContextLength, formatTps, recentSpeeds } from '@/lib/engineModels'
import { providerSettingAnchor } from '@/lib/settingsSearch'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useSettingsSearch } from '@/hooks/useSettingsSearch'
import { SettingsTabStrip, useSettingsTab } from '@/containers/SettingsTabs'
import {
  contextColumn,
  useLoadedContextWindows,
} from '@/hooks/useLoadedContextWindows'
import {
  startOfToday,
  useEngineActivity,
} from '@/stores/engine-activity-store'
import { getStatusClass, getStatusLabel, isMemorySetting } from '@/lib/providerDetailHelpers'

// as route.threadsDetail
// Remote lists longer than this get a filter box; rows render this many at a time.
const MODEL_FILTER_MIN = 20

export const Route = createFileRoute('/settings/providers/$providerName')({
  component: ProviderDetail,
  validateSearch: (search: Record<string, unknown>): { step?: string } => {
    // validate and parse the search params into a typed state
    // Omitted when absent: String(undefined) put `?step=undefined` in the URL.
    return search?.step == null ? {} : { step: String(search.step) }
  },
})


/** The last path segment, on either separator. */
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

/** A model's configured context length, when it has one. */
function contextLengthOf(model: Model): number | undefined {
  const value = (model.settings as any)?.ctx_len?.controller_props?.value
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}


/** How many recent replies the speed chart shows. */
const SPEED_WINDOW = 24

/** The engine settings a user reaches for first: open by default. */
const ENGINE_BASIC_KEYS = new Set([
  'ctx_size',
  'fit',
  'fit_target',
  'models_max',
  'idle_unload_minutes',
  'timeout',
  'threads',
  'threads_batch',
])

type DetailTab = 'models' | 'connection' | 'engine'

const CHIP_TONE = {
  success: 'ok',
  warning: 'warn',
  destructive: 'err',
  neutral: 'neutral',
  progress: 'neutral',
} as const

function ProviderDetail() {
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
  const { providerName } = useParams({ from: Route.id })
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

  /** One model as a row in the models table. */
  const loadedWindows = useLoadedContextWindows(
    isEngineProvider ? provider?.provider : undefined,
    activeModels
  )

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
    // What the model runs with, not "auto" when it inherits the Default
    // context size (C046).
    const contextLength = effectiveContextLength(model, provider)
    const displayName = getModelDisplayName(model)
    const secondaryLine = isEngineProvider
      ? (file?.fileName ?? model.id)
      : model.id
    const parsed = parseModelName(displayName)
    const quant = parsed.quant ?? parseModelName(secondaryLine).quant
    const shownName = parsed.quant ? parsed.base : displayName
    // A quant difference already shows as the quant chip.
    const disambiguator = disambiguation.get(model.id)
    const rowTitle = [
      displayName,
      secondaryLine !== displayName ? secondaryLine : null,
      file?.sizeBytes ? formatBytes(file.sizeBytes) : null,
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <li
        key={key}
        data-testid={`model-row-${model.id}`}
        className={cn(
          TBOX_ROW,
          'relative',
          // Below the threshold the row is a two-line card: identity on the
          // first line, figures + status + actions on the second.
          isEngineProvider
            ? '@max-[880px]:flex @max-[880px]:flex-wrap @max-[880px]:gap-y-2'
            : '@max-[560px]:flex @max-[560px]:flex-wrap @max-[560px]:gap-y-2',
          options.selected && 'bg-accent'
        )}
      >
        <span className="flex items-center">
          {options.leading ?? (
            <BrandMark
              logo={modelLogo(model.id, provider?.provider)}
              name={getModelDisplayName(model)}
              size={30}
            />
          )}
        </span>
        <div
          className={cn(
            'flex min-w-0 flex-col gap-0.5',
            isEngineProvider
              ? '@max-[880px]:min-w-[8rem] @max-[880px]:flex-1'
              : '@max-[560px]:min-w-[8rem] @max-[560px]:flex-1'
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className="min-w-0 truncate text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground"
              title={rowTitle}
              aria-label={rowTitle}
            >
              {shownName}
            </span>
            {options.badges}
            {model.imported && (
              <Chip
                className="h-[18px] shrink-0"
                title={t('providers:importedTooltip')}
              >
                {t('providers:imported')}
              </Chip>
            )}
            {quant && (
              <Chip
                mono
                className="h-[18px]"
                data-testid="model-quant-chip"
              >
                {quant}
              </Chip>
            )}
          </span>
          {/* A renamed model still answers to its own identifier, which is
              what requests carry; a local one also names its file. The cut
              is in the middle so the quant and extension stay readable. */}
          <MiddleText
            text={secondaryLine}
            className="font-mono text-[length:calc(var(--ui-font-base)*0.6875)] text-subtle-foreground"
            title={rowTitle}
            data-testid="model-secondary-line"
          />
          {/* What tells this model from its look-alikes, when its name
              alone would not. On its own line so it never squeezes the name. */}
          {disambiguator &&
            disambiguator.kind !== 'quant' &&
            disambiguator.label !== quant && (
              <span className="flex min-w-0">
                <Chip
                  mono
                  className="h-[18px] max-w-full min-w-0 overflow-hidden text-ellipsis"
                  title={file?.fileName ?? model.id}
                  data-testid="model-disambiguator-chip"
                >
                  {disambiguator.label}
                </Chip>
              </span>
            )}
        </div>
        {/* Always a cell, even with no capabilities: CapabilityChips renders
            nothing then, and every later column would slide one place left
            (the status pill landing in the 80px context column). Collapsed
            in the two-line card, where there are no columns to hold. */}
        <span
          data-testid="model-capabilities-cell"
          className={cn(
            'flex min-w-0 items-center',
            isEngineProvider
              ? '@max-[880px]:empty:hidden'
              : '@max-[560px]:empty:hidden'
          )}
        >
          <CapabilityChips iconOnly capabilities={model.capabilities || []} />
        </span>
        {/* Line break between the two lines of the narrow card. */}
        <span
          aria-hidden
          className={cn(
            'hidden h-0 basis-full',
            isEngineProvider ? '@max-[880px]:block' : '@max-[560px]:block'
          )}
        />
        {isEngineProvider && (
          <>
            <span className="tabular-nums text-fg-2">
              {file?.sizeBytes ? formatBytes(file.sizeBytes) : '—'}
            </span>
            {(() => {
              const ctx = contextColumn(
                loadedWindows[model.id],
                contextLength,
                t
              )
              return (
                <span
                  className="flex min-w-0 flex-col leading-tight tabular-nums text-fg-2"
                  title={ctx.title}
                  data-testid={`model-ctx-${model.id}`}
                >
                  <span className="truncate">{ctx.value}</span>
                  {ctx.note && (
                    <span className="truncate text-[length:calc(var(--ui-font-base)*0.625)] text-muted-foreground">
                      {ctx.note}
                    </span>
                  )}
                </span>
              )
            })()}
          </>
        )}
        <span
          className={cn(
            'flex min-w-0 items-center [&>*]:max-w-full [&>*]:truncate',
            isEngineProvider
              ? '@max-[880px]:min-w-[7rem] @max-[880px]:flex-1'
              : '@max-[560px]:min-w-[7rem] @max-[560px]:flex-1'
          )}
        >
          {renderStatus(model.id)}
        </span>
        <div
          className={cn(
            'flex flex-nowrap items-center justify-end gap-0.5',
            // In the two-line card the group may wrap rather than run out
            // of the row when the page is very narrow.
            isEngineProvider
              ? '@max-[880px]:ml-auto @max-[880px]:max-w-full @max-[880px]:flex-wrap'
              : '@max-[560px]:ml-auto @max-[560px]:max-w-full @max-[560px]:flex-wrap'
          )}
        >
          {options.actions}
        </div>
      </li>
    )
  }

  const sectionDivider = (label: string, className?: string) => (
    <div
      role="separator"
      aria-label={label}
      className={cn(
        'px-2 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium text-subtle-foreground uppercase',
        className
      )}
    >
      {label}
    </div>
  )

  const title = getProviderTitle(providerName)
  const loadedHere = (provider?.models ?? []).filter((m) =>
    activeModels.includes(m.id)
  )
  const diskBytes = Object.values(localFiles).reduce(
    (sum, f) => sum + (f.sizeBytes ?? 0),
    0
  )
  const providerSamples = generations.filter(
    (g) => g.provider === providerName
  )
  const averageSpeed = providerSamples.length
    ? providerSamples.reduce((a, g) => a + g.tps, 0) / providerSamples.length
    : undefined
  const repliesToday = providerSamples.filter(
    (g) => g.at >= startOfToday()
  ).length
  const keyCount = provider ? providerRemoteApiKeyChain(provider).length : 0
  const showSettings = !(isPredefinedProvider && !isEngineProvider)
  const settingRows = (provider?.settings ?? [])
    .map((setting, settingIndex) => ({ setting, settingIndex }))
    .filter(({ setting }) => {
      if (setting.key === 'api-key' && !isEngineProvider) return false
      // Azure's api-version has its own field above the key section.
      if (provider?.provider === 'azure' && setting.key === 'api-version')
        return false
      if (provider?.provider === 'llamacpp' && setting.key === 'fit_ctx')
        return false
      return true
    })
  const settingGroups = isEngineProvider
    ? [
        {
          id: 'basics',
          title: t('engine:provider.engineBasics', { defaultValue: 'Engine basics' }),
          rows: settingRows.filter(
            ({ setting }) =>
              !isMemorySetting(setting.key) &&
              ENGINE_BASIC_KEYS.has(setting.key)
          ),
        },
        {
          id: 'performance',
          title: t('system-monitor:performance'),
          rows: settingRows.filter(
            ({ setting }) =>
              !isMemorySetting(setting.key) &&
              !ENGINE_BASIC_KEYS.has(setting.key)
          ),
        },
        {
          id: 'memory',
          title: t('engine:provider.memorySettings'),
          rows: settingRows.filter(({ setting }) => isMemorySetting(setting.key)),
        },
      ].filter((g) => g.rows.length > 0)
    : [
        {
          id: 'settings',
          title: t('engine:provider.connection'),
          rows: settingRows,
        },
      ]

  // Engine groups: basics open, the long lists folded. A search result that
  // lands inside a folded group opens it first so the arrival scroll lands.
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(['basics'])
  )
  const pendingTarget = useSettingsSearch((s) => s.pendingTarget)
  useEffect(() => {
    if (!pendingTarget || !provider) return
    const owner = settingGroups.find((g) =>
      g.rows.some(
        ({ setting }) =>
          providerSettingAnchor(provider.provider, setting.key) === pendingTarget
      )
    )
    if (owner) setOpenGroups((prev) => new Set(prev).add(owner.id))
    // `settingGroups` is rebuilt on every render; the target triggers this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTarget])
  const setGroupOpen = (id: string, open: boolean) =>
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })

  const detailTabs = isEngineProvider
    ? [
        { id: 'models' as DetailTab, label: t('engine:models.title') },
        {
          id: 'engine' as DetailTab,
          label: t('common:shell.engine'),
          anchors: ['provider-setting-*'],
        },
      ]
    : [
        { id: 'models' as DetailTab, label: t('engine:models.title') },
        {
          id: 'connection' as DetailTab,
          label: t('engine:provider.connection'),
          anchors: ['provider-setting-*'],
        },
      ]
  const [detailTab, setDetailTab] = useSettingsTab<DetailTab>(detailTabs)
  // The tab set differs by provider kind: never show a tab this page lacks.
  const activeTab = detailTabs.some((d) => d.id === detailTab)
    ? detailTab
    : 'models'

  const renderSetting = ({
    setting: stored,
    settingIndex,
  }: {
    setting: ProviderSetting
    settingIndex: number
  }) => {
    // The engine's settings are English in the extension: shown localized.
    const setting = localizeEngineSetting(t, provider?.provider, stored)
    const withInfo =
      isEngineProvider && ENGINE_SETTINGS_WITH_INFO.has(setting.key)
    // Use the DynamicController component
    const actionComponent = (
      <div className="mt-1 sm:mt-0">
        <DynamicControllerSetting
          controllerType={setting.controller_type}
          controllerProps={
            setting.key === 'ctx_size'
              ? // From Auto, + goes to a usable window, not 1 token.
                {
                  ...setting.controller_props,
                  min: CONTEXT_SIZE_MIN,
                  steps: CONTEXT_SIZE_STEPS,
                }
              : setting.controller_props
          }
          className={cn(setting.key === 'device' && 'hidden')}
          onChange={(newValue) => {
            if (provider) {
              // Copy the changed setting: the stored one must not be mutated.
              const newSettings = [...provider.settings]
              const changed = newSettings[settingIndex]
              newSettings[settingIndex] = {
                ...changed,
                controller_props: {
                  ...changed.controller_props,
                  value: newValue,
                },
              } as ProviderSetting

              // Create update object with updated settings
              const updateObj: Partial<ModelProvider> = {
                settings: newSettings,
              }
              // Check if this is an API key or base URL setting and update the corresponding top-level field
              const settingKey = setting.key
              if (settingKey === 'api-key' && typeof newValue === 'string') {
                updateObj.api_key = newValue
                if (newValue && !provider?.api_key) updateObj.active = true
              } else if (
                settingKey === 'base-url' &&
                typeof newValue === 'string'
              ) {
                updateObj.base_url = newValue
              }

              const previousValue = changed.controller_props.value
              void Promise.resolve(
                serviceHub
                  .providers()
                  .updateSettings(providerName, updateObj.settings ?? [])
              ).catch((error: unknown) => {
                // The engine refused and rolled the file back: put the control
                // back on the stored value and say why, so a change that was not
                // kept is never mistaken for one that was.
                const latest = useModelProvider.getState().getProviderByName(providerName)
                if (latest) {
                  updateProvider(providerName, {
                    ...latest,
                    settings: latest.settings.map((s, i) =>
                      i === settingIndex
                        ? ({
                            ...s,
                            controller_props: {
                              ...s.controller_props,
                              value: previousValue,
                            },
                          } as ProviderSetting)
                        : s
                    ),
                  })
                }
                if (restartTimerRef.current) {
                  clearTimeout(restartTimerRef.current)
                  restartTimerRef.current = null
                  pendingRestartRef.current = null
                }
                toast.error(t('engine:provider.settingNotSaved', { setting: setting.title }), {
                  id: `engine-setting-${providerName}-${setting.key}`,
                  description: errorText(error),
                })
              })
              updateProvider(providerName, {
                ...provider,
                ...updateObj,
              })

              if (isEngineProvider) {
                if (restartTimerRef.current) {
                  clearTimeout(restartTimerRef.current)
                }
                const engine = provider.provider
                const restart = () => {
                  restartTimerRef.current = null
                  pendingRestartRef.current = null
                  void stopProviderModels(engine).catch(() => {})
                }
                pendingRestartRef.current = restart
                restartTimerRef.current = setTimeout(restart, 800)
              }
            }
          }}
        />
      </div>
    )

    return (
      <CardItem
        key={settingIndex}
        anchor={providerSettingAnchor(provider?.provider ?? '', setting.key)}
        title={
          withInfo ? (
            <span className="inline-flex items-center gap-1.5">
              {setting.title}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('engineSettings:_ui.moreInfo', {
                      setting: setting.title,
                    })}
                    data-testid={`engine-setting-info-${setting.key}`}
                    className="inline-grid size-5 place-items-center rounded-full text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
                  >
                    <Info className="size-3.5" aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  {setting.description}
                </TooltipContent>
              </Tooltip>
            </span>
          ) : (
            setting.title
          )
        }
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
                    className="text-acc-text underline-offset-4 hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                )
              },
              p: ({ ...props }) => <p {...props} className="mb-0!" />,
            }}
          />
          {setting.key === 'ctx_size' && isEngineProvider && (
            // Each model can set its own size: the Models page has them.
            <Link
              to={route.settings.providers}
              data-testid="engine-ctx-size-per-model"
              className="mt-1 inline-block text-xs text-acc-text underline-offset-4 hover:underline"
            >
              {t('engineSettings:_ui.perModelSettings')}
            </Link>
          )}
          </>
        }
        actions={actionComponent}
      />
    )
  }

  const modelsFrame = (
    <ProviderModelsFrame
  provider={provider}
  isEngineProvider={isEngineProvider}
  handleRefreshModels={handleRefreshModels}
  refreshingModels={refreshingModels}
  handleModelImportSuccess={handleModelImportSuccess}
  canFilterModels={canFilterModels}
  modelQuery={modelQuery}
  setModelQuery={setModelQuery}
  allModels={allModels}
  filteredModels={filteredModels}
  isLlamacpp={isLlamacpp}
  embeddingModels={embeddingModels}
  chatModels={chatModels}
  sectionDivider={sectionDivider}
  modelEntries={modelEntries}
  toggleGroup={toggleGroup}
  providerName={providerName}
  activeModels={activeModels}
  renderModelRow={renderModelRow}
  handleStopModel={handleStopModel}
  loadingModels={loadingModels}
  handleStartModel={handleStartModel}
  localFiles={localFiles}
  handleRevealModelFile={handleRevealModelFile}
  defaultEmbeddingModelId={defaultEmbeddingModelId}
  setDefaultEmbeddingModel={setDefaultEmbeddingModel}
  modelLimit={modelLimit}
  setModelLimit={setModelLimit}
  importingModel={importingModel}
/>
  )

  const speedFrame = (
    <Frame className="motion-safe:animate-rise-in [animation-delay:220ms]">
      <FrameHeader icon={<Icon name="x-activity" />} title={t('engine:speed.title')} />
      <FrameBody className="p-3">
        {providerSamples.length === 0 ? (
          <EmptyState
            icon={<Icon name="x-activity" />}
            title={t('engine:speed.empty')}
            description={t('engine:speed.emptyHint')}
          />
        ) : (
          <LiveChart
            series={recentSpeeds(providerSamples, SPEED_WINDOW)}
            color="var(--success)"
            label={t('engine:speed.label')}
            format={formatTps}
            windowLabel={t('engine:speed.window', {
              count: Math.min(SPEED_WINDOW, providerSamples.length),
            })}
            peakLabel={t('engine:chart.peak')}
            avgLabel={t('engine:chart.avg')}
            plotClassName="h-[110px]"
          />
        )}
      </FrameBody>
    </Frame>
  )

  const apiFrame = provider && !isEngineProvider && (
    <Frame className="motion-safe:animate-rise-in [animation-delay:260ms]">
      <FrameHeader icon={<Icon name="x-key" />} title={t('engine:provider.api')} />
      <FrameBody className="gap-4 p-3">
        {EDITABLE_ENDPOINT[provider.provider] && (
          <div className="space-y-2">
            <div className="space-y-1">
              <h3 className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                {t('providers:baseUrl.title')}
              </h3>
              <p className="text-xs leading-normal text-muted-foreground">
                {t(EDITABLE_ENDPOINT[provider.provider].description)}
              </p>
            </div>
            <input
              className="flex h-8 w-full min-w-0 rounded-lg border-[0.8px] border-input bg-card px-2.5 py-1 font-mono text-base text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11 md:text-xs"
              placeholder={EDITABLE_ENDPOINT[provider.provider].placeholder}
              value={baseUrlDraft}
              onChange={(e) => setBaseUrlDraft(e.target.value)}
              onBlur={() => commitBaseUrlDraft()}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        {provider.provider === 'azure' && (
          <div className="space-y-2">
            <div className="space-y-1">
              <h3 className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                {t('providers:apiVersion.title')}
              </h3>
              <p className="text-xs leading-normal text-muted-foreground">
                {t('providers:apiVersion.description')}
              </p>
            </div>
            <input
              className="flex h-8 w-full min-w-0 rounded-lg border-[0.8px] border-input bg-card px-2.5 py-1 font-mono text-base text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11 md:text-xs"
              placeholder="2024-10-21"
              data-testid="azure-api-version"
              value={apiVersionDraft}
              onChange={(e) => setApiVersionDraft(e.target.value)}
              onBlur={() => commitApiVersionDraft()}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        {provider.provider === 'bedrock' && <BedrockCredentials />}
        <div
          className={provider.provider === 'bedrock' ? 'hidden' : 'space-y-3'}
        >
          <div className="space-y-1">
            <h3 className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
              {t('providers:apiKeys.title')}
            </h3>
            <p className="text-xs leading-normal text-muted-foreground">
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
                          className="motion-safe:animate-spin"
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
                Primary key is <span className="font-medium">#1</span>. Flint
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
        <ProviderTlsTrust provider={provider} />
      </FrameBody>
    </Frame>
  )

  const note = provider && (
    <>
      {!isEngineProvider && !isLocalProvider(provider.provider) && (
        <div className="flex items-start gap-3 rounded-xl bg-muted px-3.5 py-3 text-xs leading-normal text-muted-foreground shadow-[inset_0_0_0_0.8px_var(--border)]">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {t('providers:limitedSupport', {
              defaultValue:
                'This provider may not be fully supported. Capabilities (tools, vision, audio) are not auto-detected - add models manually and configure capabilities per model.',
            })}
          </span>
        </div>
      )}
      {isLlamacpp && <LlamacppEngineInfo />}
      {isLlamacpp && <SkippedLinkedModelsNotice />}
      {provider.provider === 'mlx' && (
        <div className="flex items-start gap-3 rounded-xl bg-warning-tint px-3.5 py-3 text-xs leading-normal text-fg-2 shadow-[inset_0_0_0_0.8px_var(--border)]">
          <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <span>
            {t('providers:mlxExperimental', {
              defaultValue:
                'MLX support is experimental. Embeddings are unavailable, the reasoning toggle is not yet wired through, and some newer model architectures may fail to load. Report issues on GitHub so we can prioritize them.',
            })}
          </span>
        </div>
      )}
    </>
  )

  const settingsFrames = !showSettings
    ? null
    : isEngineProvider
      ? settingGroups.length > 0 && (
          <Frame className="motion-safe:animate-rise-in [animation-delay:300ms]">
            <FrameHeader
              icon={<Icon name="x-sliders" />}
              title={t('engine:provider.engineSettings')}
            />
            <FrameBody className="px-3 py-1">
              {settingGroups.map((group) => (
                <Collapsible
                  key={group.id}
                  open={openGroups.has(group.id)}
                  onOpenChange={(open) => setGroupOpen(group.id, open)}
                  data-testid={`engine-group-${group.id}`}
                  className="border-b border-dashed border-border last:border-b-0"
                >
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      data-testid={`engine-group-toggle-${group.id}`}
                      className="flex w-full items-center gap-1.5 rounded-md px-3 py-2.5 text-left text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground outline-none hover:bg-hover-row focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
                    >
                      <ChevronDown
                        className={cn(
                          'size-3.5 text-muted-foreground transition-transform duration-200',
                          !openGroups.has(group.id) && '-rotate-90'
                        )}
                        aria-hidden
                      />
                      {group.title}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {group.rows.map(renderSetting)}
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </FrameBody>
          </Frame>
        )
      : settingGroups.map((group, i) => (
          <Frame
            key={group.id}
            className="motion-safe:animate-rise-in"
            style={{ animationDelay: `${300 + i * 50}ms` }}
          >
            <FrameHeader icon={<Icon name="x-sliders" />} title={group.title} />
            <FrameBody className="px-3">{group.rows.map(renderSetting)}</FrameBody>
          </Frame>
        ))

  const dangerFrame = showSettings && !isEngineProvider && (
    <Frame className="motion-safe:animate-rise-in [animation-delay:340ms]">
      <FrameHeader icon={<Icon name="x-trash" />} title={t('engine:provider.danger')} />
      <FrameBody className="px-3">
        <DeleteProvider provider={provider} />
      </FrameBody>
    </Frame>
  )

  return (
    <div className="flex h-full w-full flex-col">
      <SettingsPageHeader title={title} />
      <SettingsWithSections>
      <EnginePage testId="provider-page">
        {isSubscriptionProvider(providerName) && (
          <SubscriptionConnect providerName={providerName} />
        )}
        <ProviderHero
          provider={provider}
          providerName={providerName}
          title={title}
          isEngineProvider={isEngineProvider}
          apiKeyMissing={apiKeyMissing}
          headerKeyStatus={headerKeyStatus}
          connectionFailed={connectionFailed}
          connectionVerified={connectionVerified}
          reachNote={reachNote}
          onActiveChange={(checked) => {
            if (!provider) return
            if (!checked && isEngineProvider) {
              void stopProviderModels(provider.provider).catch(() => {})
            }
            updateProvider(providerName, { active: checked })
          }}
        />

        <SettingsTabStrip<DetailTab>
          tabs={detailTabs}
          value={activeTab}
          onChange={setDetailTab}
          label={title}
        />

        {activeTab === 'models' && (
        <ProviderKpiRow
          isEngineProvider={isEngineProvider}
          chatModelCount={chatModels.length}
          embeddingModelCount={embeddingModels.length}
          loadedCount={loadedHere.length}
          modelCount={provider?.models.length ?? 0}
          diskBytes={diskBytes}
          localFileCount={Object.keys(localFiles).length}
          allModelCount={allModels.length}
          repliesToday={repliesToday}
          replySampleCount={providerSamples.length}
          keyCount={keyCount}
          averageSpeed={averageSpeed}
        />
        )}

        {/* janhq/jan#8374. A local model list read from the default data
            folder because the configured one could not be used is not
            an empty library: say so here, where the models are missing,
            not only in Settings > General. */}
        {activeTab === 'models' && unavailableDataFolder && isEngineProvider && (
          <p
            role="alert"
            data-testid="data-folder-unavailable-notice"
            className="rounded-xl border border-destructive/40 bg-destructive-tint px-3.5 py-2.5 text-xs text-destructive"
          >
            {t('providers:dataFolderUnavailable', {
              path: unavailableDataFolder,
            })}
          </p>
        )}

        {activeTab === 'models' && (
          <>
            {/* The library is the page: full width, so a long row never
                squeezes its actions. */}
            <div className="min-w-0">{modelsFrame}</div>
            {!isEngineProvider && note}
            {speedFrame}
          </>
        )}
        {activeTab === 'engine' && (
          // An odd last card spans the row: no half-empty row at the foot.
          <div className="grid items-stretch gap-4 min-[1000px]:grid-cols-2 [&>*]:min-w-0 [&>*:last-child:nth-child(odd)]:col-span-full">
            {note}
            {isLlamacpp && <EngineAddonFrame />}
          </div>
        )}
        {activeTab === 'engine' && settingsFrames}
        {activeTab === 'connection' && (
          <div className="flex min-w-0 flex-col gap-4">
            {apiFrame}
            {settingsFrames}
            {dangerFrame}
          </div>
        )}
      </EnginePage>
      </SettingsWithSections>
    </div>
  )
}
