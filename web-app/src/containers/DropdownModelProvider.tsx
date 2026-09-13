/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState, useRef, useMemo, useCallback, memo } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  cn,
  getProviderTitle,
  getModelDisplayName,
  isLocalProvider,
} from '@/lib/utils'
import { classifyModelLocation } from '@/lib/modelLocation'
import { highlightFzfMatch } from '@/utils/highlight'
import Capabilities from './Capabilities'
import { ArrowUpDown, Settings, X } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useThreads } from '@/hooks/useThreads'
import { ModelSetting } from '@/containers/ModelSetting'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { ModelSupportStatus } from '@/containers/ModelSupportStatus'
import { ModelEvidenceBadges } from '@/containers/ModelEvidenceBadges'
import { useModelEvidence } from '@/hooks/useModelEvidence'
import { Fzf } from 'fzf'
import { localStorageKey } from '@/constants/localStorage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { useProviderReachability } from '@/hooks/useProviderReachability'
import {
  isOffline,
  modelAvailability,
  OFFLINE_DOT_CLASS,
  OFFLINE_ROW_CLASS,
} from '@/lib/modelAvailability'
import { providerHasRemoteApiKeys as hasRemoteKeys } from '@/lib/provider-api-keys'
import { useModelOrder } from '@/hooks/useModelOrder'
import {
  MODEL_SORT_OPTIONS,
  sortModels,
  type ModelSortOption,
} from '@/lib/modelSort'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { predefinedProviders } from '@/constants/providers'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { useServiceHub } from '@/hooks/useServiceHub'
import { getLastUsedModel } from '@/utils/getModelToStart'
import { ChevronsUpDown } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type DropdownModelProviderProps = {
  model?: ThreadModel
  useLastUsedModel?: boolean
  /**
   * Where a choice is recorded, in place of the current chat thread. Cowork
   * passes its session's setter, so a choice belongs to the session in view
   * and to no other (janhq/jan#8905).
   */
  onModelChange?: (model: ThreadModel) => void
}

interface SearchableModel {
  provider: ModelProvider
  model: Model
  searchStr: string
  value: string
  highlightedId?: string
}

/** The menu entry for each order. */
const SORT_LABEL_KEYS: Record<ModelSortOption, string> = {
  'name-asc': 'common:sortNameAsc',
  'name-desc': 'common:sortNameDesc',
  recent: 'common:sortRecent',
  provider: 'common:sortProvider',
}

/**
 * "This provider just failed to answer."
 *
 * Not a probe result: it appears only after a real request to the endpoint
 * failed at the transport layer, and it goes as soon as one succeeds. An
 * installed local model that is merely unloaded never lands here.
 */
const OfflineBadge = ({ label, tooltip }: { label: string; tooltip: string }) => (
  <span
    className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/30 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
    title={tooltip}
  >
    <span className={cn('size-1.5 rounded-full', OFFLINE_DOT_CLASS)} aria-hidden />
    {label}
  </span>
)

/**
 * Where a provider's requests are processed. Stated on the section header so
 * choosing a model also says whether messages leave this device.
 */
const ProcessingLocationLabel = ({ provider }: { provider: ModelProvider }) => {
  const { t } = useTranslation()
  const location = classifyModelLocation({
    baseUrl: provider.base_url,
    builtInEngine: Boolean(isLocalProvider(provider.provider)),
  })
  if (location !== 'local' && location !== 'remote') return null
  const text = t(`model-fit:location.${location}`)
  return (
    <span className="truncate text-[10px] text-muted-foreground" title={text}>
      · {text}
    </span>
  )
}

/**
 * The identifier a renamed model is still addressed by.
 *
 * Shown only when it differs from the name on the row: under an unrenamed
 * model it would just repeat the line above it, on every entry in the list.
 */
const OriginalModelId = ({ model }: { model: Model }) =>
  model.displayName && model.displayName !== model.id ? (
    <span className="block truncate text-xs text-muted-foreground">
      {model.id}
    </span>
  ) : null

// Helper functions for localStorage
const setLastUsedModel = (provider: string, model: string) => {
  try {
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider, model })
    )
  } catch (error) {
    console.debug('Failed to set last used model in localStorage:', error)
  }
}

/**
 * Is this one of the built-in provider templates?
 *
 * Exact match. This was `predefinedProviders.some((e) => e.provider.includes(p))`,
 * which is a substring test *and* backwards: it asked whether a template's id
 * contains the user's provider name, so a provider called `ai` matched `openai`
 * and one called `x` matched `xai`. A user whose provider name happened to be a
 * substring of a template's had it silently reclassified as a built-in.
 */
function isPredefinedProvider(providerName: string): boolean {
  return predefinedProviders.some((e) => e.provider === providerName)
}

/**
 * Should this provider's models be offered in the picker?
 *
 * The rule that matters: a provider the user configured, which has models, is
 * always offered. Only an *unconfigured built-in template* is hidden, and that
 * is what the API-key check is for -- it is a proxy for "the user has not set
 * this one up", never a gate on providers they plainly did set up.
 *
 * Keying that gate on `api_key` alone is what made models vanish from the bar
 * after a restart. `partialize` strips `api_key` and `api_key_fallbacks` before
 * persisting -- keys live in the OS keyring -- so on every launch every
 * provider looks keyless until `applyKeyringKeys()` re-seeds them. Combined
 * with the substring bug above, a custom provider with a short name was
 * reclassified as built-in, found keyless, and had all of its models dropped.
 */
function offersModels(provider: {
  provider: string
  models: unknown[]
  api_key?: string
  api_key_fallbacks?: string[]
}): boolean {
  // The bundled local runtime is always offered.
  if (provider.provider === 'llamacpp') return true
  // Anything the user added, with models discovered under it.
  if (!isPredefinedProvider(provider.provider)) return provider.models.length > 0
  // A built-in template: offered once it has a key, or models the user added.
  return providerHasRemoteApiKeys(provider) || provider.models.length > 0
}

const DropdownModelProvider = memo(function DropdownModelProvider({
  model,
  useLastUsedModel = false,
  onModelChange,
}: DropdownModelProviderProps) {
  const {
    providers,
    getProviderByName,
    selectModelProvider,
    getModelBy,
    selectedProvider,
    selectedModel,
    updateProvider,
  } = useModelProvider()
  const [displayModel, setDisplayModel] = useState<string>('')
  const { updateCurrentThreadModel } = useThreads()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { favoriteModels } = useFavoriteModel()
  const { sort, setSort, lastUsed, markUsed } = useModelOrder()
  const unreachableOrigins = useProviderReachability((s) => s.unreachable)

  /** Has a real request to this model's endpoint just failed? */
  const modelIsOffline = useCallback(
    (item: SearchableModel) =>
      isOffline(
        modelAvailability({
          // Where inference runs. A LAN or tailnet endpoint needs no API key,
          // and treating it as remote made the picker demand one.
          isLocal:
            classifyModelLocation({
              baseUrl: item.provider.base_url,
              builtInEngine: Boolean(isLocalProvider(item.provider.provider)),
            }) !== 'remote',
          providerActive: item.provider.active !== false,
          hasApiKey: Boolean(hasRemoteKeys(item.provider)),
          baseUrl: item.provider.base_url,
          unreachableOrigins,
        })
      ),
    [unreachableOrigins]
  )
  const serviceHub = useServiceHub()

  // Search state
  const [open, setOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Helper function to check if a model exists in providers
  const checkModelExists = useCallback(
    (providerName: string, modelId: string) => {
      const provider = providers.find(
        (p) => p.provider === providerName && p.active
      )
      return provider?.models.find((m) => m.id === modelId)
    },
    [providers]
  )

  // Helper function to get context size from model settings
  const getContextSize = useCallback((): number => {
    if (!selectedModel?.settings?.ctx_len?.controller_props?.value) {
      return 8192 // Default context size
    }
    return selectedModel.settings.ctx_len.controller_props.value as number
  }, [selectedModel?.settings?.ctx_len?.controller_props?.value])

  // Function to check if a llamacpp model has vision capabilities and update model capabilities
  const checkAndUpdateModelVisionCapability = useCallback(
    async (modelId: string) => {
      try {
        const hasVision = await serviceHub.models().checkMmprojExists(modelId)
        if (hasVision) {
          // Update the model capabilities to include 'vision'
          const provider = getProviderByName('llamacpp')
          if (provider) {
            const modelIndex = provider.models.findIndex(
              (m) => m.id === modelId
            )
            if (modelIndex !== -1) {
              const model = provider.models[modelIndex]
              const capabilities = model.capabilities || []

              // Add 'vision' capability if not already present AND if user hasn't manually configured capabilities
              // Check if model has a custom capabilities config flag

              const hasUserConfiguredCapabilities =
                (model as any)._userConfiguredCapabilities === true

              if (
                !capabilities.includes('vision') &&
                !hasUserConfiguredCapabilities
              ) {
                const updatedModels = [...provider.models]
                updatedModels[modelIndex] = {
                  ...model,
                  capabilities: [...capabilities, 'vision'],
                  // Mark this as auto-detected, not user-configured
                  _autoDetectedVision: true,
                } as any

                updateProvider('llamacpp', { models: updatedModels })
              }
            }
          }
        }
      } catch (error) {
        console.debug('Error checking mmproj for model:', modelId, error)
      }
    },
    [getProviderByName, updateProvider, serviceHub]
  )

  // Initialize model provider - avoid race conditions with manual selections
  useEffect(() => {
    const initializeModel = async () => {
      // Auto select model when existing thread is passed
      if (model) {
        selectModelProvider(model?.provider as string, model?.id as string)
        if (!checkModelExists(model.provider, model.id)) {
          selectModelProvider('', '')
        }
        // Check mmproj existence for llamacpp models
        if (model?.provider === 'llamacpp') {
          await serviceHub
            .models()
            .checkMmprojExistsAndUpdateOffloadMMprojSetting(
              model.id as string,
              updateProvider,
              getProviderByName
            )
          // Also check vision capability
          await checkAndUpdateModelVisionCapability(model.id as string)
        }
      } else if (useLastUsedModel) {
        // Initialise, never re-decide. This effect re-runs on every change to
        // `providers` -- a model list refreshing, a capability probe writing
        // back through `updateProvider` -- and re-deciding each time cleared a
        // model the user had just picked whenever it was momentarily missing
        // from an active provider's list. The picker kept showing it (that is
        // local display state), while the composer's selection was empty and
        // it refused to send: no run, no turn, nothing in the transcript.
        // An existing selection stays. If the model really is gone, sending
        // fails with an error the user can act on, which is better than a
        // composer that silently does nothing.
        if (useModelProvider.getState().selectedModel) return
        // A default the user set wins over whatever was used last; when it is
        // no longer available, the last-used model applies as before.
        const preferred = useModelEvidence.getState().preferredModel
        const lastUsed =
          preferred && checkModelExists(preferred.provider, preferred.model)
            ? preferred
            : getLastUsedModel()
        if (lastUsed && checkModelExists(lastUsed.provider, lastUsed.model)) {
          selectModelProvider(lastUsed.provider, lastUsed.model)
          if (lastUsed.provider === 'llamacpp') {
            await serviceHub
              .models()
              .checkMmprojExistsAndUpdateOffloadMMprojSetting(
                lastUsed.model,
                updateProvider,
                getProviderByName
              )
            // Also check vision capability
            await checkAndUpdateModelVisionCapability(lastUsed.model)
          }
        } else {
          // Fallback: auto-select first llamacpp model if available
          const llamacppProvider = providers.find(
            (p) => p.provider === 'llamacpp' && p.active && p.models.length > 0
          )
          if (llamacppProvider && llamacppProvider.models.length > 0) {
            const firstModel = llamacppProvider.models[0]
            selectModelProvider('llamacpp', firstModel.id)
            setLastUsedModel('llamacpp', firstModel.id)
          } else {
            selectModelProvider('', '')
          }
        }
      }
    }

    initializeModel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    model,
    selectModelProvider,
    updateCurrentThreadModel,
    providers,
    checkModelExists,
    updateProvider,
    getProviderByName,
    checkAndUpdateModelVisionCapability,

    // selectedModel and selectedProvider intentionally excluded to prevent race conditions
  ])

  // Update display model when selection changes
  useEffect(() => {
    if (selectedProvider && selectedModel) {
      setDisplayModel(getModelDisplayName(selectedModel))
    } else {
      setDisplayModel(t('common:selectAModel'))
    }
  }, [selectedProvider, selectedModel, t])

  // Check vision capabilities for all llamacpp models
  useEffect(() => {
    const checkAllLlamacppModelsForVision = async () => {
      const llamacppProvider = providers.find(
        (p) => p.provider === 'llamacpp' && p.active
      )
      if (llamacppProvider) {
        const checkPromises = llamacppProvider.models.map((model) =>
          checkAndUpdateModelVisionCapability(model.id)
        )
        await Promise.allSettled(checkPromises)
      }
    }

    if (open) {
      checkAllLlamacppModelsForVision()
    }
  }, [open, providers, checkAndUpdateModelVisionCapability])

  // Reset search value when dropdown closes
  const onOpenChange = useCallback((open: boolean) => {
    setOpen(open)
    if (!open) {
      requestAnimationFrame(() => setSearchValue(''))
    } else {
      // Focus search input when opening
      setTimeout(() => {
        searchInputRef.current?.focus()
      }, 100)
    }
  }, [])

  // Clear search and focus input
  const onClearSearch = useCallback(() => {
    setSearchValue('')
    searchInputRef.current?.focus()
  }, [])

  // Create searchable items from all models
  const searchableItems = useMemo(() => {
    const items: SearchableModel[] = []

    providers.forEach((provider) => {
      if (!provider.active) return

      provider.models.forEach((modelItem) => {
        // Skip embedding models - they can't be used for chat
        if (modelItem.embedding) return

        // Only an unconfigured built-in template is hidden. See `offersModels`.
        if (!offersModels(provider)) return

        const capabilities = modelItem.capabilities || []
        const capabilitiesString = capabilities.join(' ')
        const providerTitle = getProviderTitle(provider.provider)

        // Create search string with model id, provider, and capabilities
        const searchStr =
          `${modelItem.id} ${providerTitle} ${provider.provider} ${capabilitiesString}`.toLowerCase()

        items.push({
          provider,
          model: modelItem,
          searchStr,
          value: `${provider.provider}:${modelItem.id}`,
        })
      })
    })

    return items
  }, [providers])

  // Create Fzf instance for fuzzy search
  const fzfInstance = useMemo(() => {
    return new Fzf(searchableItems, {
      selector: (item) =>
        `${getModelDisplayName(item.model)} ${item.model.id}`.toLowerCase(),
    })
  }, [searchableItems])

  // Get favorite models that are currently available
  const favoriteItems = useMemo(() => {
    return searchableItems.filter((item) =>
      favoriteModels.some((fav) => fav.id === item.model.id)
    )
  }, [searchableItems, favoriteModels])

  // Filter models based on search value
  const filteredItems = useMemo(() => {
    if (!searchValue) return searchableItems

    return fzfInstance.find(searchValue.toLowerCase()).map((result) => {
      const item = result.item
      const positions = Array.from(result.positions) || []
      const highlightedId = highlightFzfMatch(
        item.model.id,
        positions,
        'text-brand-text'
      )

      return {
        ...item,
        highlightedId,
      }
    })
  }, [searchableItems, searchValue, fzfInstance])

  /**
   * Provider sections are one of the orders, and a search has an order of its
   * own — relevance — that an alphabet would bury the best match under.
   */
  const wantsFlatList = !searchValue && sort !== 'provider'

  // The browsable list in the order the user chose. Favorites are pinned above
  // it, so they are not repeated here.
  const flatItems = useMemo(() => {
    if (!wantsFlatList) return []
    return sortModels(filteredItems, sort, lastUsed).filter(
      (item) => !favoriteModels.some((fav) => fav.id === item.model.id)
    )
  }, [filteredItems, wantsFlatList, sort, lastUsed, favoriteModels])

  // With nothing to list, the provider sections are still worth showing: their
  // headers are how a user reaches a provider's settings to add a model.
  const isGrouped = !wantsFlatList || flatItems.length === 0

  // Group filtered items by provider, excluding favorites when not searching
  const groupedItems = useMemo(() => {
    const groups: Record<string, SearchableModel[]> = {}

    if (!searchValue) {
      // When not searching, show all active providers (even without models)
      // Sort: local first, then providers with API keys or custom with models, then others, alphabetically
      const activeProviders = providers
        .filter((p) => p.active)
        .sort((a, b) => {
          const aIsLocal = a.provider === 'llamacpp' || a.provider === 'mlx'
          const bIsLocal = b.provider === 'llamacpp' || b.provider === 'mlx'
          // Local (llamacpp) first
          if (aIsLocal && !bIsLocal) return -1
          if (!aIsLocal && bIsLocal) return 1

          // Configured providers sort above unconfigured templates. Same
          // predicate as the visibility gate, so the two cannot disagree about
          // what "configured" means.
          const aHasApiKeyOrCustomModel = offersModels(a)
          const bHasApiKeyOrCustomModel = offersModels(b)
          // Providers with API keys or custom with models filled second
          if (aHasApiKeyOrCustomModel && !bHasApiKeyOrCustomModel) return -1
          if (!aHasApiKeyOrCustomModel && bHasApiKeyOrCustomModel) return 1

          // Sort remaining by provider name
          return a.provider.localeCompare(b.provider)
        })

      activeProviders.forEach((provider) => {
        groups[provider.provider] = []
      })
    }

    // Add the filtered items to their respective groups
    filteredItems.forEach((item) => {
      const providerKey = item.provider.provider
      if (!groups[providerKey]) {
        groups[providerKey] = []
      }

      // When not searching, exclude favorite models from regular provider sections
      const isFavorite = favoriteModels.some((fav) => fav.id === item.model.id)
      if (!searchValue && isFavorite) return // Skip adding this item to regular provider section

      groups[providerKey].push(item)
    })

    // Within a section the order is alphabetical by the name on screen, except
    // while searching, where the ranking is the quality of the match.
    if (!searchValue) {
      for (const key of Object.keys(groups)) {
        groups[key] = sortModels(groups[key], 'name-asc')
      }
    }

    return groups
  }, [filteredItems, providers, searchValue, favoriteModels])

  const handleSelect = useCallback(
    async (searchableModel: SearchableModel) => {
      // Immediately update display to prevent double-click issues
      setDisplayModel(getModelDisplayName(searchableModel.model))
      setSearchValue('')
      setOpen(false)

      selectModelProvider(
        searchableModel.provider.provider,
        searchableModel.model.id
      )
      ;(onModelChange ?? updateCurrentThreadModel)({
        id: searchableModel.model.id,
        provider: searchableModel.provider.provider,
      })

      // Store the selected model as last used
      setLastUsedModel(
        searchableModel.provider.provider,
        searchableModel.model.id
      )
      // …and in the history the "recently used" order reads, which keeps one
      // entry per model rather than only the single most recent one.
      markUsed(searchableModel.provider.provider, searchableModel.model.id)


      // Check mmproj existence for llamacpp models (async, don't block UI)
      if (searchableModel.provider.provider === 'llamacpp') {
        serviceHub
          .models()
          .checkMmprojExistsAndUpdateOffloadMMprojSetting(
            searchableModel.model.id,
            updateProvider,
            getProviderByName
          )
          .catch((error) => {
            console.debug(
              'Error checking mmproj for model:',
              searchableModel.model.id,
              error
            )
          })

        // Also check vision capability (async, don't block UI)
        checkAndUpdateModelVisionCapability(searchableModel.model.id).catch(
          (error) => {
            console.debug(
              'Error checking vision capability for model:',
              searchableModel.model.id,
              error
            )
          }
        )
      }
    },
    [
      selectModelProvider,
      updateCurrentThreadModel,
      onModelChange,
      updateProvider,
      getProviderByName,
      checkAndUpdateModelVisionCapability,
      serviceHub,
      markUsed,
    ]
  )

  /** Rows are selectable with Enter or Space, not only with a pointer. */
  const selectableRow = (item: SearchableModel, isSelected: boolean) => ({
    role: 'button' as const,
    tabIndex: 0,
    'aria-pressed': isSelected,
    onClick: () => handleSelect(item),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        handleSelect(item)
      }
    },
  })

  const [settingsOpen, setSettingsOpen] = useState(false)

  const currentModel = selectedModel?.id
    ? getModelBy(selectedModel?.id)
    : undefined

  if (!providers.length) return null

  const provider = getProviderByName(selectedProvider)


  return (
    <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <div className="relative z-20 flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-line-strong bg-card px-2.5 text-sm transition-colors hover:bg-sunken pointer-coarse:h-11">
            <button
              type="button"
              className="relative z-20 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {provider && (
                <div className="shrink-0">
                  <ProvidersAvatar provider={provider} />
                </div>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      'text-foreground truncate leading-normal',
                      !selectedModel?.id && 'text-muted-foreground'
                    )}
                  >
                    {displayModel}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{displayModel}</TooltipContent>
              </Tooltip>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
          {currentModel?.settings &&
            provider &&
            provider.provider === 'llamacpp' && (
              <div onClick={(e) => e.stopPropagation()}>
                <ModelSetting
                  model={currentModel as Model}
                  provider={provider}
                  open={settingsOpen}
                  onOpenChange={setSettingsOpen}
                />
              </div>
            )}
          <ModelSupportStatus
            modelId={selectedModel?.id}
            provider={selectedProvider}
            contextSize={getContextSize()}
            className="ml-0.5 shrink-0"
            onAdjustSettings={
              currentModel?.settings && provider?.provider === 'llamacpp'
                ? () => setSettingsOpen(true)
                : undefined
            }
          />
        </div>
        </PopoverTrigger>

      <PopoverContent
        className={cn(
          // Use auto width to fit long model names; keep a sensible minimum.
          'w-auto min-w-70 max-w-[90vw] p-0 bg-card border border-line-strong',
          searchValue.length === 0 && 'h-80'
        )}
        align="start"
        // sideOffset={16}
        // alignOffset={-10}
        side="bottom"
        avoidCollisions={searchValue.length === 0 ? true : false}
      >
        <div className="flex flex-col size-full">
          {/* Search input */}
          <div className="flex items-center gap-1 p-2 border-b border-border">
            <input
              ref={searchInputRef}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder={t('common:searchModels')}
              className="min-w-0 flex-1 bg-transparent text-base font-normal outline-0 md:text-sm"
            />
            {searchValue.length > 0 && (
              <button
                type="button"
                aria-label={t('common:dismiss')}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sunken hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
                onClick={onClearSearch}
              >
                <X className="size-4" />
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('common:sortModels')}
                  title={t('common:sortModels')}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md bg-sunken transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ArrowUpDown className="size-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>{t('common:sortModels')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={sort}
                  onValueChange={(value) => setSort(value as ModelSortOption)}
                >
                  {MODEL_SORT_OPTIONS.map((option) => (
                    <DropdownMenuRadioItem key={option} value={option}>
                      {t(SORT_LABEL_KEYS[option])}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Model list */}
          <div className="max-h-80 overflow-y-auto">
            {Object.keys(groupedItems).length === 0 && searchValue ? (
              <div className="py-3 px-4 text-sm ">
                {t('common:noModelsFoundFor', { searchValue })}
              </div>
            ) : (
              <div className="py-1">
                {/* Favorites section - only show when not searching */}
                {!searchValue && favoriteItems.length > 0 && (
                  <div className="bg-sunken/60 rounded-md m-2 py-1">
                    {/* Favorites header */}
                    <div className="flex items-center gap-1.5 px-2 py-1">
                      <span className="text-sm font-medium text-muted-foreground">
                        {t('common:favorites')}
                      </span>
                    </div>

                    {/* Favorite models */}
                    {favoriteItems.map((searchableModel) => {
                      const isSelected =
                        selectedModel?.id === searchableModel.model.id &&
                        selectedProvider === searchableModel.provider.provider
                      const capabilities =
                        searchableModel.model.capabilities || []

                      return (
                        <div
                          key={`fav-${searchableModel.value}`}
                          {...selectableRow(searchableModel, isSelected)}
                          className={cn(
                            'mx-1 mb-1 px-2 py-1.5 rounded-sm cursor-pointer flex items-center gap-2 transition-all duration-200',
                            'hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11',
                            modelIsOffline(searchableModel) && OFFLINE_ROW_CLASS,
                            // Selected state needs stronger contrast than the surrounding secondary tint.
                            isSelected &&
                              'relative bg-brand-tint hover:bg-brand-tint font-medium before:absolute before:left-0 before:inset-y-1.5 before:w-0.5 before:rounded-full before:bg-brand'
                          )}
                        >
                          <div className="flex items-center gap-1 flex-1 min-w-0">
                            <div className="shrink-0 -ml-1">
                              <ProvidersAvatar
                                provider={searchableModel.provider}
                              />
                            </div>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="min-w-0 flex-1">
                                  <span className="flex items-center text-sm">
                                    <span className="truncate">
                                      {getModelDisplayName(searchableModel.model)}
                                    </span>
                                    {modelIsOffline(searchableModel) && (
                                      <OfflineBadge
                                        label={t('common:modelOffline.badge')}
                                        tooltip={t('common:modelOffline.tooltip')}
                                      />
                                    )}
                                  </span>
                                  <OriginalModelId
                                    model={searchableModel.model}
                                  />
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                {searchableModel.model.id}
                              </TooltipContent>
                            </Tooltip>
                            <ModelEvidenceBadges
                              provider={searchableModel.provider.provider}
                              model={searchableModel.model}
                            />
                            {capabilities.length > 0 && (
                              <div className="shrink-0 -mr-1.5">
                                <Capabilities capabilities={capabilities} />
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Divider between favorites and regular providers */}
                {favoriteItems.length > 0 && (
                  <div className="border-b border-border mx-2"></div>
                )}

                {/* One ordered list, or a section per provider */}
                {!isGrouped ? (
                  <div className="bg-sunken/60 rounded-md my-1.5 mx-1.5 py-1">
                    {flatItems.map((searchableModel) => {
                      const isSelected =
                        selectedModel?.id === searchableModel.model.id &&
                        selectedProvider === searchableModel.provider.provider
                      const capabilities =
                        searchableModel.model.capabilities || []
                      const modelName = getModelDisplayName(
                        searchableModel.model
                      )

                      return (
                        <div
                          key={searchableModel.value}
                          {...selectableRow(searchableModel, isSelected)}
                          className={cn(
                            'mx-1 mb-1 px-2 py-1.5 rounded-sm cursor-pointer flex items-center gap-2 transition-all duration-200',
                            'hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11',
                            modelIsOffline(searchableModel) && OFFLINE_ROW_CLASS,
                            isSelected &&
                              'relative bg-brand-tint hover:bg-brand-tint font-medium before:absolute before:left-0 before:inset-y-1.5 before:w-0.5 before:rounded-full before:bg-brand'
                          )}
                        >
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <div className="shrink-0 -ml-1">
                              <ProvidersAvatar
                                provider={searchableModel.provider}
                              />
                            </div>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="min-w-0 flex-1">
                                  <span className="flex items-center text-sm">
                                    <span className="truncate">{modelName}</span>
                                    {modelIsOffline(searchableModel) && (
                                      <OfflineBadge
                                        label={t('common:modelOffline.badge')}
                                        tooltip={t('common:modelOffline.tooltip')}
                                      />
                                    )}
                                  </span>
                                  {/* A single list has no provider header, so
                                      the row carries it — with the original
                                      identifier when the name hides it. */}
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {getProviderTitle(
                                      searchableModel.provider.provider
                                    )}
                                    {modelName !== searchableModel.model.id
                                      ? ` · ${searchableModel.model.id}`
                                      : ''}
                                  </span>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                {searchableModel.model.id}
                              </TooltipContent>
                            </Tooltip>
                            <ModelEvidenceBadges
                              provider={searchableModel.provider.provider}
                              model={searchableModel.model}
                            />
                            {capabilities.length > 0 && (
                              <div className="shrink-0 -mr-1.5">
                                <Capabilities capabilities={capabilities} />
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  Object.entries(groupedItems).map(([providerKey, models]) => {
                  const providerInfo = providers.find(
                    (p) => p.provider === providerKey
                  )

                  if (!providerInfo) return null

                  return (
                    <div
                      key={providerKey}
                      className="bg-sunken/60 first:mt-0 rounded-md my-1.5 mx-1.5 first:mb-0 py-1"
                    >
                      {/* Provider header */}
                      <div className="flex items-center justify-between px-2 py-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <ProvidersAvatar provider={providerInfo} />
                          <span className="capitalize text-sm font-medium text-muted-foreground">
                            {getProviderTitle(providerInfo.provider)}
                          </span>
                          <ProcessingLocationLabel provider={providerInfo} />
                        </div>

                        <button
                          type="button"
                          aria-label={t('model-fit:providerSettings', {
                            provider: getProviderTitle(providerInfo.provider),
                          })}
                          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-card focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate({
                              to: route.settings.providers,
                              params: { providerName: providerInfo.provider },
                            })
                            setOpen(false)
                          }}
                        >
                          <Settings className="size-4 text-muted-foreground" />
                        </button>
                      </div>

                      {/* Models for this provider */}
                      {models.length === 0 ? (
                        // Show message when provider has no available models
                        <></>
                      ) : (
                        models.map((searchableModel) => {
                          const isSelected =
                            selectedModel?.id === searchableModel.model.id &&
                            selectedProvider ===
                              searchableModel.provider.provider
                          const capabilities =
                            searchableModel.model.capabilities || []

                          return (
                            <div
                              key={searchableModel.value}
                              {...selectableRow(searchableModel, isSelected)}
                              className={cn(
                                'mx-1 mb-1 px-2 py-1.5 rounded-sm cursor-pointer flex items-center gap-2 transition-all duration-200',
                                'hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11',
                                modelIsOffline(searchableModel) && OFFLINE_ROW_CLASS,
                                isSelected &&
                                  'relative bg-brand-tint hover:bg-brand-tint font-medium before:absolute before:left-0 before:inset-y-1.5 before:w-0.5 before:rounded-full before:bg-brand'
                              )}
                            >
                              <div className="flex items-center gap-2 flex-1 min-w-0">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div className="min-w-0 flex-1">
                                      <span className="flex items-center text-sm">
                                        <span className="truncate">
                                          {getModelDisplayName(
                                            searchableModel.model
                                          )}
                                        </span>
                                        {modelIsOffline(searchableModel) && (
                                          <OfflineBadge
                                            label={t('common:modelOffline.badge')}
                                            tooltip={t(
                                              'common:modelOffline.tooltip'
                                            )}
                                          />
                                        )}
                                      </span>
                                      <OriginalModelId
                                        model={searchableModel.model}
                                      />
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {searchableModel.model.id}
                                  </TooltipContent>
                                </Tooltip>
                                <ModelEvidenceBadges
                              provider={searchableModel.provider.provider}
                              model={searchableModel.model}
                            />
                            {capabilities.length > 0 && (
                                  <div className="shrink-0 -mr-1.5">
                                    <Capabilities capabilities={capabilities} />
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })
                      )}
                    </div>
                  )
                  })
                )}
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
})

export default DropdownModelProvider
