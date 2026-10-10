/* eslint-disable @typescript-eslint/no-explicit-any */
import { syncListedModels } from '@/lib/providerModelSync'
import { listedCapabilities } from '@/lib/listedCapabilities'
import { CardItem } from '@/containers/Card'
import { classifyModelLocation } from '@/lib/modelLocation'
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
import { createFileRoute, Link, useParams } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { DynamicControllerSetting } from '@/containers/dynamicControllerSetting'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { DialogEditModel } from '@/containers/dialogs/EditModel'
import { ImportLlamacppModelDialog } from '@/containers/dialogs/ImportLlamacppModelDialog'
import { ImportMlxModelDialog } from '@/containers/dialogs/ImportMlxModelDialog'
import { ModelSetting } from '@/containers/ModelSetting'
import { LlamacppEngineInfo } from '@/containers/LlamacppEngineInfo'
import { DialogDeleteModel } from '@/containers/dialogs/DeleteModel'
import { DialogDeleteAllModels } from '@/containers/dialogs/DeleteAllModels'
import { FavoriteModelAction } from '@/containers/FavoriteModelAction'
import DeleteProvider from '@/containers/dialogs/DeleteProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SecretInput } from '@/components/ui/secret-input'
import { ProviderCustomHeaders } from '@/containers/ProviderCustomHeaders'
import { applyCustomHeaders } from '@/lib/customHeaders'
import { applyProviderAuthHeader } from '@/lib/anthropicHeaders'
import { Switch } from '@/components/ui/switch'
import {
  CircleCheck,
  Circle,
  FolderOpen,
  FolderPlus,
  Info,
  LoaderCircle,
  RefreshCw,
  Search,
} from 'lucide-react'
import { Icon } from '@/components/ui/icon'
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
import {
  SettingsPageHeader,
  SettingsWithSections,
} from '@/containers/SettingsPageHeader'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import {
  CapabilityChips,
  EnginePage,
  KpiRow,
  KpiTile,
  TBOX_ROW,
  TBox,
} from '@/containers/engine/EngineKit'
import { BrandMark } from '@/containers/engine/BrandMark'
import { LiveChart } from '@/containers/engine/LiveChart'
import { modelLogo, providerLogo } from '@/lib/brandLogos'
import { formatTps, recentSpeeds } from '@/lib/engineModels'
import {
  startOfToday,
  useEngineActivity,
} from '@/stores/engine-activity-store'

// as route.threadsDetail
/**
 * Built-in providers whose endpoint depends on the account, so it stays
 * editable: OpenAI for proxies and gateways that speak its API, Azure on the
 * resource name, Alibaba Qwen on the region its keys were created in.
 */
const EDITABLE_ENDPOINT: Record<string, { description: string; placeholder: string }> = {
  openai: {
    description: 'providers:baseUrl.openaiDescription',
    placeholder: 'https://api.openai.com/v1',
  },
  azure: {
    description: 'providers:baseUrl.azureDescription',
    placeholder: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
  },
  qwen: {
    description: 'providers:baseUrl.qwenDescription',
    placeholder: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  },
}

// Remote lists longer than this get a filter box; rows render this many at a time.
const MODEL_FILTER_MIN = 20
const MODEL_PAGE_SIZE = 50

export const Route = createFileRoute('/settings/providers/$providerName')({
  component: ProviderDetail,
  validateSearch: (search: Record<string, unknown>): { step?: string } => {
    // validate and parse the search params into a typed state
    // Omitted when absent: String(undefined) put `?step=undefined` in the URL.
    return search?.step == null ? {} : { step: String(search.step) }
  },
})

/** What the file list on disk says about one installed model. */
type LocalFileInfo = { sizeBytes?: number; fileName?: string; path?: string }

/** The last path segment, on either separator. */
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

/** A model's configured context length, when it has one. */
function contextLengthOf(model: Model): number | undefined {
  const value = (model.settings as any)?.ctx_len?.controller_props?.value
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Models table columns: mark, name, capabilities, (size, context,) status, actions. */
const LOCAL_COLS =
  '30px minmax(110px,1fr) 64px 60px 64px 136px auto'
const REMOTE_COLS = '30px minmax(140px,1fr) 72px 130px auto'

/** How many recent replies the speed chart shows. */
const SPEED_WINDOW = 24

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
  const { setModelLoadError } = useModelLoad()
  const [activeModels, setActiveModels] = useAppState(
    useShallow((state) => [state.activeModels, state.setActiveModels])
  )
  // A load started anywhere else in the app (a chat, the API server).
  const globallyLoadingModelId = useAppState(
    (state) => state.modelLoadProgress?.modelId
  )
  const generations = useEngineActivity((s) => s.generations)
  const [loadingModels, setLoadingModels] = useState<string[]>([])
  /** Models whose last start from this page threw; cleared by a success. */
  const [failedModels, setFailedModels] = useState<string[]>([])
  /** A request with the saved keys succeeded while this page was open. */
  const [connectionVerified, setConnectionVerified] = useState(false)
  // The last model refresh was refused or unreachable: "Connected" would be a
  // claim about a key that has just been shown not to work.
  const [connectionFailed, setConnectionFailed] = useState(false)
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
  // A hosted provider can list hundreds of models, so past a threshold the
  // list gets a filter box and renders in pages instead of all at once.
  const [modelQuery, setModelQuery] = useState('')
  const [modelLimit, setModelLimit] = useState(MODEL_PAGE_SIZE)
  const canFilterModels = !isEngineProvider && allModels.length > MODEL_FILTER_MIN
  const filteredModels = useMemo(() => {
    const words = modelQuery.toLowerCase().split(/\s+/).filter(Boolean)
    if (!canFilterModels || words.length === 0) return allModels
    return allModels.filter((m) => {
      const hay = `${m.id} ${m.name ?? ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [allModels, canFilterModels, modelQuery])
  useEffect(() => setModelLimit(MODEL_PAGE_SIZE), [modelQuery, providerName])
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

  useEffect(() => {
    if (!provider || !EDITABLE_ENDPOINT[provider.provider]) return
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
    if (!provider || !EDITABLE_ENDPOINT[provider.provider]) return
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
        }
        applyProviderAuthHeader(provider, headers, key)
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
      if (results.some((r) => r.status === 'ok')) {
        setConnectionVerified(true)
        setConnectionFailed(false)
      }
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
      setConnectionVerified(true)
      setConnectionFailed(false)
      const newModels: Model[] = modelIds.map((id) => ({
        id,
        model: id,
        name: id,
        capabilities: [
          'completion',
          ...(listedCapabilities(provider.base_url, id) ?? []),
        ],
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

        toast.success(t('providers:models'), {
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
          description: t('providers:noNewModels'),
        })
      }
    } catch (error) {
      setConnectionVerified(false)
      setConnectionFailed(true)
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
        const message = errorText(error, 'Model could not start')
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
      <Chip
        tone={CHIP_TONE[modelStatusTone(status)]}
        dot
        live={status === 'loading' || status === 'loaded'}
        data-testid={`model-status-${modelId}`}
        data-status={status}
      >
        {t(modelStatusLabelKey(status))}
      </Chip>
    )
  }

  /** One model as a row in the models table. */
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
    return (
      <li
        key={key}
        data-testid={`model-row-${model.id}`}
        className={cn(
          TBOX_ROW,
          'relative',
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
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className="min-w-0 truncate text-[13px] font-medium text-foreground"
              title={model.id}
            >
              {getModelDisplayName(model)}
            </span>
            {options.badges}
            {model.imported && (
              <Chip
                className="h-[18px]"
                title={t('providers:importedTooltip')}
              >
                {t('providers:imported')}
              </Chip>
            )}
          </span>
          {/* A renamed model still answers to its own identifier, which is
              what requests carry; a local one also names its file. */}
          <small className="truncate font-mono text-[11px] text-subtle-foreground">
            {isEngineProvider
              ? (file?.fileName ?? model.id)
              : model.id}
          </small>
        </div>
        <CapabilityChips iconOnly capabilities={model.capabilities || []} />
        {isEngineProvider && (
          <>
            <span className="tabular-nums text-fg-2">
              {file?.sizeBytes ? formatBytes(file.sizeBytes) : '—'}
            </span>
            <span className="tabular-nums text-fg-2">
              {contextLength ? contextLength.toLocaleString() : '—'}
            </span>
          </>
        )}
        <span className="flex min-w-0 items-center">
          {renderStatus(model.id)}
        </span>
        <div className="flex flex-nowrap items-center justify-end gap-0.5">
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
        'px-2 text-[11px] font-medium text-subtle-foreground uppercase',
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
      if (provider?.provider === 'llamacpp' && setting.key === 'fit_ctx')
        return false
      return true
    })
  // The engine's options are long; split the memory ones into their own
  // group so the two sit side by side instead of one very tall column.
  const isMemorySetting = (key: string) =>
    /cache|mmap|mlock|kv|rope|batch|defrag|flash|offload|split|tensor|memory/i.test(
      key
    )
  const settingGroups = isEngineProvider
    ? [
        {
          id: 'engine',
          title: t('engine:provider.engineSettings'),
          icon: <Icon name="x-sliders" />,
          rows: settingRows.filter(({ setting }) => !isMemorySetting(setting.key)),
        },
        {
          id: 'memory',
          title: t('engine:provider.memorySettings'),
          icon: <Icon name="x-disk" />,
          rows: settingRows.filter(({ setting }) => isMemorySetting(setting.key)),
        },
      ].filter((g) => g.rows.length > 0)
    : [
        {
          id: 'settings',
          title: t('engine:provider.connection'),
          icon: <Icon name="x-sliders" />,
          rows: settingRows,
        },
      ]

  const renderSetting = ({
    setting,
    settingIndex,
  }: {
    setting: ProviderSetting
    settingIndex: number
  }) => {
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
              if (settingKey === 'api-key' && typeof newValue === 'string') {
                updateObj.api_key = newValue
              } else if (
                settingKey === 'base-url' &&
                typeof newValue === 'string'
              ) {
                updateObj.base_url = newValue
              }

              serviceHub
                .providers()
                .updateSettings(providerName, updateObj.settings ?? [])
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
        }
        actions={actionComponent}
      />
    )
  }

  const modelsFrame = (
    <Frame className="motion-safe:animate-rise-in [animation-delay:160ms]">
      <FrameHeader
        icon={<Icon name="x-cube" />}
        title={t('providers:models')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {provider && !isEngineProvider && (
              <>
                <Button
                  variant="ghost"
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
                      className="motion-safe:animate-spin text-muted-foreground"
                      aria-hidden
                    />
                  ) : (
                    <RefreshCw className="text-muted-foreground" aria-hidden />
                  )}
                </Button>
                <DialogDeleteAllModels provider={provider} remote />
                <DialogAddModel provider={provider} />
              </>
            )}
            {provider && isEngineProvider && (
              <DialogDeleteAllModels provider={provider} />
            )}
            {provider && provider.provider === 'llamacpp' && (
              <ImportLlamacppModelDialog
                provider={provider}
                onSuccess={handleModelImportSuccess}
                trigger={
                  <Button size="sm" className="pointer-coarse:h-11">
                    <FolderPlus aria-hidden />
                    <span>{t('providers:import')}</span>
                  </Button>
                }
              />
            )}
            {provider && provider.provider === 'mlx' && (
              <ImportMlxModelDialog
                provider={provider}
                onSuccess={handleModelImportSuccess}
                trigger={
                  <Button size="sm" className="pointer-coarse:h-11">
                    <FolderPlus aria-hidden />
                    <span>{t('providers:import')}</span>
                  </Button>
                }
              />
            )}
          </div>
        }
      />
      <FrameBody className="overflow-x-auto p-3">
        {canFilterModels && (
          <div className="relative mb-2">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={modelQuery}
              onChange={(e) => setModelQuery(e.target.value)}
              placeholder={t('providers:filterModels', {
                count: allModels.length,
              })}
              aria-label={t('providers:filterModels', {
                count: allModels.length,
              })}
              className="pl-8"
            />
          </div>
        )}
        {provider?.models.length ? (
          <TBox
            className={isEngineProvider ? 'min-w-[660px]' : 'min-w-[480px]'}
            columns={isEngineProvider ? LOCAL_COLS : REMOTE_COLS}
          >
            {isLlamacpp &&
              embeddingModels.length > 0 &&
              chatModels.length > 0 &&
              sectionDivider(t('providers:chatModels'), 'mt-1 mb-1')}
            <ul className="flex flex-col">
              {(isLlamacpp
                ? chatModels
                : filteredModels.slice(0, modelLimit)
              ).map((model, modelIndex) => {
                const isActive = activeModels.some(
                  (activeModel) => activeModel === model.id
                )
                return renderModelRow(model, String(modelIndex), {
                  actions: (
                    <>
                      {isEngineProvider && (
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
                              variant="outline"
                              className="min-w-14 pointer-coarse:h-11"
                              disabled={loadingModels.includes(model.id)}
                              onClick={() => handleStartModel(model.id)}
                            >
                              {loadingModels.includes(model.id) ? (
                                <LoaderCircle
                                  className="motion-safe:animate-spin"
                                  aria-label={t('providers:status.loading')}
                                />
                              ) : (
                                t('providers:start')
                              )}
                            </Button>
                          )}
                        </span>
                      )}
                      {model.settings &&
                        provider &&
                        provider.provider === 'llamacpp' && (
                          <ModelSetting provider={provider} model={model} />
                        )}
                      {isEngineProvider && localFiles[model.id]?.path && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground pointer-coarse:size-11"
                          aria-label={t('providers:revealModelFile')}
                          title={t('providers:revealModelFile')}
                          onClick={() => handleRevealModelFile(localFiles[model.id].path!)}
                        >
                          <FolderOpen aria-hidden />
                        </Button>
                      )}
                      <DialogEditModel provider={provider} modelId={model.id} />
                      {((provider &&
                        !predefinedProviders.some(
                          (p) => p.provider === provider.provider
                        )) ||
                        (provider &&
                          predefinedProviders.some(
                            (p) => p.provider === provider.provider
                          ) &&
                          providerHasRemoteApiKeys(provider))) && (
                        <FavoriteModelAction
                          model={model}
                          provider={provider.provider}
                        />
                      )}
                      <DialogDeleteModel provider={provider} modelId={model.id} />
                    </>
                  ),
                })
              })}
            </ul>
            {isLlamacpp && provider && embeddingModels.length > 0 && (
              <>
                {sectionDivider(t('providers:embeddingModels'), 'mt-4 mb-1')}
                <ul className="flex flex-col">
                  {embeddingModels.map((model, modelIndex) => {
                    const isDefault = defaultEmbeddingModelId === model.id
                    return renderModelRow(model, `embedding-${modelIndex}`, {
                      selected: isDefault,
                      leading: (
                        <button
                          type="button"
                          onClick={() =>
                            setDefaultEmbeddingModel('llamacpp', model.id)
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
                          className="grid size-[30px] shrink-0 place-items-center rounded-md transition-colors hover:bg-hover-btn focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
                        >
                          {isDefault ? (
                            <CircleCheck
                              className="size-4.5 text-acc-text"
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
                        <Chip className="h-[18px]">
                          {t('providers:embeddingModelDefault')}
                        </Chip>
                      ),
                      actions: (
                        <>
                          {model.settings && (
                            <ModelSetting provider={provider} model={model} />
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
          </TBox>
        ) : (
          <EmptyState
            icon={<Icon name="x-cube" />}
            title={t('providers:noModelFound')}
            description={
              provider && !isLocalProvider(provider.provider)
                ? t('providers:noModelFoundRemoteDesc')
                : t('providers:noModelFoundDesc')
            }
            action={
              provider && isLocalProvider(provider.provider) ? (
                <Button variant="outline" size="sm" asChild>
                  <Link to={route.hub.index}>
                    {t('providers:browseHuggingFace')}
                  </Link>
                </Button>
              ) : undefined
            }
          />
        )}
        {canFilterModels && (
          <div className="mt-2 flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {t('providers:modelsShown', {
                shown: Math.min(modelLimit, filteredModels.length),
                total: filteredModels.length,
              })}
            </span>
            {filteredModels.length > modelLimit && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setModelLimit((n) => n + MODEL_PAGE_SIZE)}
              >
                {t('providers:showMoreModels')}
              </Button>
            )}
          </div>
        )}
        {/* Show importing skeleton first if there's one */}
        {importingModel && (
          <div
            key="importing-skeleton"
            role="status"
            className="flex min-h-11 items-center gap-2 border-t border-dashed border-border px-2 py-3"
          >
            <Chip live>Importing...</Chip>
            <span className="min-w-0 truncate font-medium text-foreground">
              {importingModel}
            </span>
          </div>
        )}
      </FrameBody>
    </Frame>
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
              <h3 className="text-[13px] font-medium text-foreground">
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
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-[13px] font-medium text-foreground">
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

  const settingsFrames = showSettings
    ? settingGroups.map((group, i) => (
        <Frame
          key={group.id}
          className="motion-safe:animate-rise-in"
          style={{ animationDelay: `${300 + i * 50}ms` }}
        >
          <FrameHeader icon={group.icon} title={group.title} />
          <FrameBody className="px-3">{group.rows.map(renderSetting)}</FrameBody>
        </Frame>
      ))
    : null

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
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-[14px] bg-muted bg-[repeating-linear-gradient(-62deg,transparent_0_10px,rgba(127,127,127,.06)_10px_10.8px)] p-4 shadow-[inset_0_0_0_0.8px_var(--border)] motion-safe:animate-rise-in">
          <div className="flex min-w-0 items-center gap-3.5">
            <BrandMark
              logo={providerLogo(providerName)}
              name={title}
              size={48}
              className="rounded-xl shadow-[0_0_0_0.8px_var(--border),0_8px_20px_-12px_rgba(0,0,0,.5)]"
            />
            <div className="min-w-0">
              <h2 className="mb-2 truncate text-[22px] leading-none font-medium text-foreground">
                {title}
              </h2>
              <div className="flex flex-wrap items-center gap-1.5">
                {provider?.active ? (
                  isEngineProvider ? (
                    <Chip tone="ok" live>
                      {t('engine:status.running')}
                    </Chip>
                  ) : apiKeyMissing ? (
                    <Chip tone="warn" dot>
                      {t('engine:status.noKey')}
                    </Chip>
                  ) : connectionFailed ? (
                    <Chip tone="warn" dot>
                      {t('providers:status.failed')}
                    </Chip>
                  ) : (
                    <Chip tone="ok" dot>
                      {connectionVerified
                        ? t('engine:status.verified')
                        : providerKeyStatus(provider) === 'keyless'
                          ? t('engine:status.keyless')
                          : t('engine:status.connected')}
                    </Chip>
                  )
                ) : (
                  <Chip dot>{t('engine:status.off')}</Chip>
                )}
                <Chip>
                  {isEngineProvider
                    ? t('engine:providers.onDevice')
                    : t('engine:provider.remoteNote')}
                </Chip>
                <Chip>
                  {t('engine:providers.modelsCount', {
                    count: provider?.models.length ?? 0,
                  })}
                </Chip>
              </div>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs font-medium text-secondary-foreground">
            <Switch
              aria-label={t('providers:useProvider', { provider: title })}
              checked={provider?.active ?? false}
              onCheckedChange={(checked) =>
                provider && updateProvider(providerName, { active: checked })
              }
            />
            {t('engine:provider.enabled')}
          </label>
        </div>

        <KpiRow>
          {isEngineProvider ? (
            <>
              <KpiTile
                title={t('engine:kpi.installed')}
                icon={<Icon name="x-cube" />}
                value={chatModels.length}
                sub={t('engine:kpi.embeddingSub', {
                  count: embeddingModels.length,
                })}
                delay={40}
              />
              <KpiTile
                title={t('engine:kpi.loaded')}
                icon={<Icon name="x-cpu" />}
                value={loadedHere.length}
                sub={t('engine:kpi.loadedSub', {
                  count: provider?.models.length ?? 0,
                })}
                delay={80}
              />
              <KpiTile
                title={t('engine:kpi.disk')}
                icon={<Icon name="x-disk" />}
                value={diskBytes > 0 ? formatBytes(diskBytes) : '—'}
                sub={t('engine:kpi.diskSub', {
                  count: Object.keys(localFiles).length,
                })}
                delay={120}
              />
            </>
          ) : (
            <>
              <KpiTile
                title={t('providers:models')}
                icon={<Icon name="x-cube" />}
                value={allModels.length}
                sub={t('engine:kpi.addedSub')}
                delay={40}
              />
              <KpiTile
                title={t('engine:kpi.repliesToday')}
                icon={<Icon name="x-activity" />}
                value={repliesToday}
                sub={t('engine:kpi.repliesSub', {
                  count: providerSamples.length,
                })}
                delay={80}
              />
              <KpiTile
                title={t('engine:kpi.apiKeys')}
                icon={<Icon name="x-key" />}
                value={keyCount}
                sub={
                  keyCount > 1
                    ? t('engine:kpi.fallbackSub', { count: keyCount - 1 })
                    : t('engine:kpi.noFallbackSub')
                }
                delay={120}
              />
            </>
          )}
          <KpiTile
            title={t('engine:kpi.avgSpeed')}
            icon={<Icon name="zap" />}
            value={averageSpeed !== undefined ? formatTps(averageSpeed) : '—'}
            sub={
              averageSpeed !== undefined
                ? t('engine:kpi.repliesSub', { count: providerSamples.length })
                : t('engine:kpi.fastestNone')
            }
            delay={160}
          />
        </KpiRow>

        {/* janhq/jan#8374. A local model list read from the default data
            folder because the configured one could not be used is not
            an empty library: say so here, where the models are missing,
            not only in Settings > General. */}
        {unavailableDataFolder && isEngineProvider && (
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

        <div className="grid items-start gap-4 min-[1150px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            {modelsFrame}
            {!isEngineProvider && speedFrame}
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            {note}
            {isEngineProvider ? speedFrame : apiFrame}
            {!isEngineProvider && settingsFrames}
            {dangerFrame}
          </div>
        </div>

        {isEngineProvider && settingsFrames && settingsFrames.length > 0 && (
          <div className="grid items-start gap-4 min-[1150px]:grid-cols-2">
            {settingsFrames}
          </div>
        )}
      </EnginePage>
      </SettingsWithSections>
    </div>
  )
}
