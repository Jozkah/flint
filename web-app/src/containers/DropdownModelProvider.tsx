/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState, useRef, useMemo, useCallback, memo } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverAnchor,
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
import { ArrowUpDown, Search, Settings, X } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useThreads } from '@/hooks/useThreads'
import {
  selectionForThreadModel,
  useConversationPane,
} from '@/hooks/useConversationPane'
import { ModelSetting } from '@/containers/ModelSetting'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { ModelAvatar } from '@/containers/ModelAvatar'
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
  providerIsUnreachable,
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
import { offersModels } from '@/lib/providerOffers'
import { modelsNeedingVisionProbe } from '@/lib/visionProbe'
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

/** A section heading in the picker: Favorites, local, cloud. */
const SECTION_HEADING =
  'px-2 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-subtle-foreground uppercase'

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
    className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/30 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
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

/** Whether a provider's requests stay on this device or network. */
const locationKind = (provider: ModelProvider): 'local' | 'remote' =>
  classifyModelLocation({
    baseUrl: provider.base_url,
    builtInEngine: Boolean(isLocalProvider(provider.provider)),
  }) === 'remote'
    ? 'remote'
    : 'local'

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

// `offersModels` (the rule for which providers appear in a model picker) is
// shared with the Rooms participant picker so every surface offers the same
// providers. See `@/lib/providerOffers`.

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
    selectedProvider: globalProvider,
    selectedModel: globalModel,
    updateProvider,
  } = useModelProvider()
  const [displayModel, setDisplayModel] = useState<string>('')
  const { updateCurrentThreadModel, updateThreadModel, threads } = useThreads()
  // In a split conversation each pane shows, and changes, its own thread's
  // model only. No pane moves the global picker, which new chats and a
  // conversation shown on its own read.
  const pane = useConversationPane()
  const inSplitPane = Boolean(pane?.isSplit)
  // A caller that passes `onModelChange` keeps the choice itself (Cowork
  // records it on its session). Such a picker shows and changes that caller's
  // model only; writing it into the global store too would silently change
  // the model every ordinary chat uses, and the store is persisted.
  const ownsSelection = Boolean(onModelChange)
  const drivesGlobalSelection =
    !ownsSelection && !pane?.isSplit
  const paneThreadModel = pane?.isSplit
    ? threads?.[pane.threadId]?.model
    : undefined
  const { selectedProvider, selectedModel } = useMemo(
    () =>
      inSplitPane || ownsSelection
        ? selectionForThreadModel(inSplitPane ? paneThreadModel : model, {
            selectedProvider: globalProvider,
            selectedModel: globalModel,
            getProviderByName,
          })
        : { selectedProvider: globalProvider, selectedModel: globalModel },
    // `providers` is why getProviderByName's answer can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      inSplitPane,
      ownsSelection,
      model,
      paneThreadModel,
      globalProvider,
      globalModel,
      getProviderByName,
      providers,
    ]
  )
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
      // A split pane the user is not working in leaves the global picker to
      // the pane they are; it becomes the one deciding when it is activated.
      if (pane?.isSplit && !pane.isActive) return
      // Auto select model when existing thread is passed
      if (model) {
        // A caller that owns its model shows it from the prop; the global
        // selection is not the place to record it.
        if (drivesGlobalSelection) {
          selectModelProvider(model?.provider as string, model?.id as string)
          if (!checkModelExists(model.provider, model.id)) {
            selectModelProvider('', '')
          }
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
    drivesGlobalSelection,
    pane,

    // selectedModel and selectedProvider intentionally excluded to prevent race conditions
  ])

  // The chat's or session's own model, when its provider (or the model) is
  // gone: removed, or turned off. The picker names it as unavailable rather
  // than quietly showing another model or an empty "Select a model".
  const unavailableModel =
    model?.id && !checkModelExists(model.provider, model.id) ? model : undefined

  // Update display model when selection changes
  useEffect(() => {
    if (selectedProvider && selectedModel) {
      setDisplayModel(getModelDisplayName(selectedModel))
    } else if (unavailableModel) {
      setDisplayModel(
        t('common:modelUnavailable', { model: unavailableModel.id })
      )
    } else {
      setDisplayModel(t('common:selectAModel'))
    }
  }, [selectedProvider, selectedModel, unavailableModel, t])

  // Models already probed for vision while the dropdown is open. The effect
  // below re-runs on every providers-store change (including the ones the
  // probe itself makes), and each probe is an uncached IPC/filesystem call,
  // so a model is probed at most once per opening.
  const visionProbedRef = useRef<Set<string>>(new Set())

  // Check vision capabilities for all llamacpp models
  useEffect(() => {
    if (!open) {
      visionProbedRef.current = new Set()
      return
    }
    const llamacppProvider = providers.find(
      (p) => p.provider === 'llamacpp' && p.active
    )
    if (!llamacppProvider) return
    const toProbe = modelsNeedingVisionProbe(
      llamacppProvider.models,
      visionProbedRef.current
    )
    for (const id of toProbe) visionProbedRef.current.add(id)
    void Promise.allSettled(
      toProbe.map((id) => checkAndUpdateModelVisionCapability(id))
    )
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
        'text-acc-text'
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
    // Models from a provider that did not answer go last.
    return sortModels(filteredItems, sort, lastUsed, modelIsOffline).filter(
      (item) => !favoriteModels.some((fav) => fav.id === item.model.id)
    )
  }, [filteredItems, wantsFlatList, sort, lastUsed, favoriteModels, modelIsOffline])

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

          // A provider that did not answer its last request goes last.
          const aDown = providerIsUnreachable(a, unreachableOrigins)
          const bDown = providerIsUnreachable(b, unreachableOrigins)
          if (aDown !== bDown) return aDown ? 1 : -1

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
  }, [filteredItems, providers, searchValue, favoriteModels, unreachableOrigins])

  const handleSelect = useCallback(
    async (searchableModel: SearchableModel) => {
      // Immediately update display to prevent double-click issues
      setDisplayModel(getModelDisplayName(searchableModel.model))
      setSearchValue('')
      setOpen(false)

      const choice = {
        id: searchableModel.model.id,
        provider: searchableModel.provider.provider,
      }
      if (drivesGlobalSelection) {
        selectModelProvider(choice.provider, choice.id)
      }
      if (onModelChange) onModelChange(choice)
      // A split pane records the choice on its own thread, not on whichever
      // thread happens to be current.
      else if (pane?.isSplit) updateThreadModel(pane.threadId, choice)
      else updateCurrentThreadModel(choice)

      // Store the selected model as last used, unless the caller owns the
      // choice: a scoped pick must not become the next new chat's default.
      if (!ownsSelection) {
        setLastUsedModel(
          searchableModel.provider.provider,
          searchableModel.model.id
        )
        // …and in the history the "recently used" order reads, which keeps
        // one entry per model rather than only the single most recent one.
        markUsed(searchableModel.provider.provider, searchableModel.model.id)
      }


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
      ownsSelection,
      updateThreadModel,
      drivesGlobalSelection,
      pane,
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

  /**
   * One model: its mark, its name over its identifier, what is known about it
   * here, and what it can do. The same row in every list, so a model looks
   * the same whether it is a favourite, in a provider's section or in the
   * single sorted list.
   */
  const renderRow = (
    item: SearchableModel,
    list: 'fav' | 'flat' | 'group'
  ) => {
    const isSelected =
      selectedModel?.id === item.model.id &&
      selectedProvider === item.provider.provider
    const capabilities = item.model.capabilities || []
    const modelName = getModelDisplayName(item.model)
    const offline = modelIsOffline(item)
    // A single list has no provider header, so the row carries the provider.
    const secondary =
      list === 'flat'
        ? `${getProviderTitle(item.provider.provider)}${modelName !== item.model.id ? ` · ${item.model.id}` : ''}`
        : modelName !== item.model.id
          ? item.model.id
          : undefined
    return (
      <div
        key={`${list}-${item.value}`}
        {...selectableRow(item, isSelected)}
        className={cn(
          'group/mrow flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition-[background-color,transform] duration-150 motion-safe:animate-mi-in motion-safe:active:scale-[.985]',
          'hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11',
          offline && OFFLINE_ROW_CLASS,
          isSelected && 'bg-accent'
        )}
      >
        <ModelAvatar
          modelId={item.model.id}
          name={modelName}
          provider={item.provider.provider}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="min-w-0 flex-1">
              <span className="flex items-center text-[13px] font-medium text-foreground">
                <span className="truncate">{modelName}</span>
                {offline && (
                  <OfflineBadge
                    label={t('common:modelOffline.badge')}
                    tooltip={t('common:modelOffline.tooltip')}
                  />
                )}
              </span>
              {secondary && (
                <span
                  className={cn(
                    'block truncate text-subtle-foreground',
                    list === 'flat' ? 'text-[11px]' : 'font-mono text-[11px]'
                  )}
                >
                  {secondary}
                </span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent>{item.model.id}</TooltipContent>
        </Tooltip>
        <ModelEvidenceBadges
          provider={item.provider.provider}
          model={item.model}
        />
        {capabilities.length > 0 && (
          <span className="ml-1 shrink-0">
            <Capabilities capabilities={capabilities} compact />
          </span>
        )}
      </div>
    )
  }

  const [settingsOpen, setSettingsOpen] = useState(false)

  const currentModel = selectedModel?.id
    ? getModelBy(selectedModel?.id)
    : undefined

  if (!providers.length) return null

  const provider = getProviderByName(selectedProvider)


  return (
    <Popover open={open} onOpenChange={onOpenChange}>
        {/* The pill anchors the popover; its model button opens it. The pill
            also holds the settings and support controls, which are not part
            of the trigger (a div carrying aria-expanded failed axe). */}
        <PopoverAnchor asChild>
          <div data-slot="model-pill" className="relative z-20 flex h-[30px] min-w-0 max-w-full shrink items-center gap-[7px] rounded-lg border-[0.8px] border-border bg-card px-2 text-[12.5px] transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-lift data-[state=open]:border-border-strong data-[state=open]:shadow-lift pointer-coarse:h-11">
            <PopoverTrigger asChild>
            <button
              type="button"
              className="relative z-20 flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm font-medium outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {provider && selectedModel?.id ? (
                <ModelAvatar
                  modelId={selectedModel.id}
                  name={displayModel}
                  provider={provider.provider}
                />
              ) : provider ? (
                <div className="shrink-0">
                  <ProvidersAvatar provider={provider} />
                </div>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-left leading-normal text-foreground',
                      !selectedModel?.id && 'text-muted-foreground'
                    )}
                    data-unavailable={
                      !selectedModel?.id && unavailableModel ? '' : undefined
                    }
                  >
                    {displayModel}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{displayModel}</TooltipContent>
              </Tooltip>
              <ChevronsUpDown className="size-[13px] shrink-0 text-muted-foreground" />
            </button>
            </PopoverTrigger>
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
        </PopoverAnchor>
        

      <PopoverContent
        className={cn(
          // Use auto width to fit long model names; keep a sensible minimum.
          'w-[360px] max-w-[calc(100vw-24px)] p-1.5',
          searchValue.length === 0 && 'h-[26rem]'
        )}
        align="end"
        // sideOffset={16}
        // alignOffset={-10}
        side="bottom"
        avoidCollisions={searchValue.length === 0 ? true : false}
      >
        <div className="flex flex-col size-full">
          {/* Search input */}
          <div className="flex items-center gap-2 border-b border-dashed border-border px-2 pt-1.5 pb-2">
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={searchInputRef}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder={t('common:searchModels')}
              className="min-w-0 flex-1 bg-transparent text-base font-normal text-foreground outline-0 placeholder:text-muted-foreground md:text-[13px]"
            />
            {searchValue.length > 0 && (
              <button
                type="button"
                aria-label={t('common:dismiss')}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
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
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
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
          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
            {Object.keys(groupedItems).length === 0 && searchValue ? (
              <div className="py-3 px-4 text-sm ">
                {t('common:noModelsFoundFor', { searchValue })}
              </div>
            ) : (
              <div className="pb-1">
                {/* Favorites section - only show when not searching */}
                {!searchValue && favoriteItems.length > 0 && (
                  <div>
                    <p className={SECTION_HEADING}>{t('common:favorites')}</p>
                    {favoriteItems.map((item) => renderRow(item, 'fav'))}
                  </div>
                )}

                {/* One ordered list, or a section per provider */}
                {!isGrouped ? (
                  <div className="pt-1">
                    {flatItems.map((item) => renderRow(item, 'flat'))}
                  </div>
                ) : (
                  Object.entries(groupedItems).map(([providerKey, models], groupIndex, entries) => {
                  const providerInfo = providers.find(
                    (p) => p.provider === providerKey
                  )

                  if (!providerInfo) return null

                  // Local and cloud models are two groups: a heading goes
                  // above the first provider of each kind, so choosing a
                  // model also says whether messages leave this computer.
                  const kind = locationKind(providerInfo)
                  const previous = entries
                    .slice(0, groupIndex)
                    .map(([key]) => providers.find((p) => p.provider === key))
                    .filter((p): p is ModelProvider => Boolean(p))
                    .pop()
                  const startsKind =
                    !searchValue &&
                    (!previous || locationKind(previous) !== kind)

                  return (
                    <div key={providerKey}>
                    {startsKind && (
                      <p
                        className={SECTION_HEADING}
                        data-testid={`model-group-${kind}`}
                      >
                        {kind === 'local'
                          ? t('model-fit:picker.local')
                          : `${t('model-fit:picker.remote')} · ${t('model-fit:picker.remoteHint')}`}
                      </p>
                    )}
                    <div>
                      {/* Provider header: its mark, its name, where it runs,
                          and a way to its settings. */}
                      <div className="group/prov flex items-center justify-between gap-2 px-2 pt-1.5 pb-0.5">
                        <div className="flex min-w-0 items-center gap-1.5 text-xs">
                          <span className="shrink-0 [&_[data-slot=brand-mark]]:!size-3.5">
                            <ProvidersAvatar provider={providerInfo} />
                          </span>
                          <span className="font-semibold text-foreground">
                            {getProviderTitle(providerInfo.provider)}
                          </span>
                          <ProcessingLocationLabel provider={providerInfo} />
                        </div>

                        <button
                          type="button"
                          aria-label={t('model-fit:providerSettings', {
                            provider: getProviderTitle(providerInfo.provider),
                          })}
                          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-subtle-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate({
                              to: route.settings.providers,
                              params: { providerName: providerInfo.provider },
                            })
                            setOpen(false)
                          }}
                        >
                          <Settings className="size-3.5" />
                        </button>
                      </div>

                      {/* Models for this provider */}
                      {models.map((item) => renderRow(item, 'group'))}
                    </div>
                    </div>
                  )
                  })
                )}
              </div>
            )}
          </div>
          {/* What this conversation uses, apart from what it could use.
              Hidden while searching, where only matches belong. */}
          {!searchValue && selectedModel?.id && provider && (
            <div
              className="mt-1.5 shrink-0 border-t border-dashed border-border px-2 py-2 text-xs text-muted-foreground"
              data-testid="model-picker-in-use"
            >
              <span className="block truncate">
                {t('model-fit:picker.inUse', {
                  model: getModelDisplayName(selectedModel),
                  provider: getProviderTitle(provider.provider),
                })}
              </span>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
})

export default DropdownModelProvider
