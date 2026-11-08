import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelEvidence } from '@/hooks/useModelEvidence'
import type { ConversationPane } from '@/hooks/useConversationPane'
import type { FavoriteModel } from '@/hooks/useFavoriteModel'
import type { ModelProviderState } from '@/lib/providerState'
import type { ServiceHub } from '@/services'
import {
  buildDisambiguation,
  buildPickerGroups,
  buildSearchableItems,
  filterBySearch,
  findAmbiguousModelIds,
  isFavoriteItem,
  makeRemoteLabeler,
  type SearchableModel,
} from '@/lib/modelPickerItems'
import { sortModels, type ModelSortOption } from '@/lib/modelSort'
import { modelsNeedingVisionProbe } from '@/lib/visionProbe'
import { getLastUsedModel } from '@/utils/getModelToStart'
import { setLastUsedModel } from '@/containers/dropdownModelConsts'

/**
 * Hooks of the model picker (`DropdownModelProvider`). Each one is a run of
 * hooks the picker calls in this same order; they are split out only to keep
 * the component readable.
 */

// Function to check if a llamacpp model has vision capabilities and update model capabilities
export function useCheckModelVisionCapability(
  getProviderByName: ModelProviderState['getProviderByName'],
  updateProvider: ModelProviderState['updateProvider'],
  serviceHub: ServiceHub
) {
  return useCallback(
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
                model._userConfiguredCapabilities === true

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
                }

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
}

/**
 * Initialize model provider - avoid race conditions with manual selections.
 *
 * The effect reads the store and the helpers through `latestRef`, so it
 * re-runs only when what it decides on changes (the target model, whether it
 * exists yet, whether any model has loaded) and not on every providers
 * write. A capability probe writes back through `updateProvider`; re-running
 * on that re-probed the same model with fresh IPC calls each time.
 */
export function useInitializeModelSelection({
  model,
  checkModelExists,
  getProviderByName,
  updateProvider,
  checkAndUpdateModelVisionCapability,
  selectModelProvider,
  serviceHub,
  providers,
  pane,
  drivesGlobalSelection,
  useLastUsedModel,
}: {
  model: ThreadModel | undefined
  checkModelExists: (providerName: string, modelId: string) => Model | undefined
  getProviderByName: ModelProviderState['getProviderByName']
  updateProvider: ModelProviderState['updateProvider']
  checkAndUpdateModelVisionCapability: (modelId: string) => Promise<void>
  selectModelProvider: ModelProviderState['selectModelProvider']
  serviceHub: ServiceHub
  providers: ModelProvider[]
  pane: ConversationPane | null | undefined
  drivesGlobalSelection: boolean
  useLastUsedModel: boolean
}) {
  const latestRef = useRef({
    model,
    checkModelExists,
    getProviderByName,
    updateProvider,
    checkAndUpdateModelVisionCapability,
    selectModelProvider,
    serviceHub,
  })
  latestRef.current = {
    model,
    checkModelExists,
    getProviderByName,
    updateProvider,
    checkAndUpdateModelVisionCapability,
    selectModelProvider,
    serviceHub,
  }
  const probedModelsRef = useRef<Set<string>>(new Set())
  const targetProvider = model?.provider
  const targetId = model?.id
  const targetExists = model
    ? Boolean(checkModelExists(model.provider, model.id))
    : false
  const anyModelLoaded = providers.some((p) => p.active && p.models.length > 0)
  const paneSplit = pane?.isSplit
  const paneActive = pane?.isActive

  useEffect(() => {
    let cancelled = false
    const initializeModel = async () => {
      const h = latestRef.current
      const target = h.model
      // A split pane the user is not working in leaves the global picker to
      // the pane they are; it becomes the one deciding when it is activated.
      if (paneSplit && !paneActive) return
      // Probe a model's mmproj and vision support once per mount.
      const probe = async (provider: string, id: string) => {
        if (provider !== 'llamacpp') return
        const key = `${provider}:${id}`
        if (probedModelsRef.current.has(key)) return
        probedModelsRef.current.add(key)
        await h.serviceHub
          .models()
          .checkMmprojExistsAndUpdateOffloadMMprojSetting(
            id,
            h.updateProvider,
            h.getProviderByName
          )
        if (cancelled) return
        // Also check vision capability
        await h.checkAndUpdateModelVisionCapability(id)
      }
      // Auto select model when existing thread is passed
      if (target) {
        // A caller that owns its model shows it from the prop; the global
        // selection is not the place to record it.
        if (drivesGlobalSelection) {
          h.selectModelProvider(target.provider as string, target.id as string)
          if (!h.checkModelExists(target.provider, target.id)) {
            h.selectModelProvider('', '')
          }
        }
        // Check mmproj existence for llamacpp models
        await probe(target.provider as string, target.id as string)
      } else if (useLastUsedModel) {
        // Initialise, never re-decide. This effect used to re-run on every
        // change to `providers` -- a model list refreshing, a capability probe
        // writing back through `updateProvider` -- and re-deciding each time
        // cleared a model the user had just picked whenever it was momentarily
        // missing from an active provider's list. The picker kept showing it
        // (that is local display state), while the composer's selection was
        // empty and it refused to send: no run, no turn, nothing in the
        // transcript. An existing selection stays. If the model really is
        // gone, sending fails with an error the user can act on, which is
        // better than a composer that silently does nothing.
        if (useModelProvider.getState().selectedModel) return
        // A default the user set wins over whatever was used last; when it is
        // no longer available, the last-used model applies as before.
        const preferred = useModelEvidence.getState().preferredModel
        const lastUsed =
          preferred && h.checkModelExists(preferred.provider, preferred.model)
            ? preferred
            : getLastUsedModel()
        if (lastUsed && h.checkModelExists(lastUsed.provider, lastUsed.model)) {
          h.selectModelProvider(lastUsed.provider, lastUsed.model)
          await probe(lastUsed.provider, lastUsed.model)
        } else {
          // Fallback: auto-select first llamacpp model if available
          const llamacppProvider = useModelProvider
            .getState()
            .providers.find(
              (p) => p.provider === 'llamacpp' && p.active && p.models.length > 0
            )
          if (llamacppProvider && llamacppProvider.models.length > 0) {
            const firstModel = llamacppProvider.models[0]
            h.selectModelProvider('llamacpp', firstModel.id)
            setLastUsedModel('llamacpp', firstModel.id)
          } else {
            h.selectModelProvider('', '')
          }
        }
      }
    }

    void initializeModel()
    return () => {
      cancelled = true
    }
    // selectedModel and selectedProvider intentionally excluded to prevent race conditions
  }, [
    targetProvider,
    targetId,
    targetExists,
    anyModelLoaded,
    drivesGlobalSelection,
    useLastUsedModel,
    paneSplit,
    paneActive,
  ])
}

/**
 * Check vision capabilities for all llamacpp models while the picker is open.
 *
 * Models already probed for vision while the dropdown is open. The effect
 * re-runs on every providers-store change (including the ones the probe
 * itself makes), and each probe is an uncached IPC/filesystem call, so a
 * model is probed at most once per opening.
 */
export function useLlamacppVisionProbe(
  open: boolean,
  providers: ModelProvider[],
  checkAndUpdateModelVisionCapability: (modelId: string) => Promise<void>
) {
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
}

/** The picker's lists: searchable items, favourites, the flat list and the provider sections. */
export function useModelPickerLists({
  providers,
  hideProvider,
  selectedProvider,
  selectedModelId,
  favoriteModels,
  searchValue,
  sort,
  lastUsed,
  modelIsOffline,
  unreachableOrigins,
}: {
  providers: ModelProvider[]
  hideProvider: (provider: ModelProvider) => boolean
  selectedProvider: string
  selectedModelId: string | undefined
  favoriteModels: FavoriteModel[]
  searchValue: string
  sort: ModelSortOption
  lastUsed: Record<string, number>
  modelIsOffline: (item: SearchableModel) => boolean
  unreachableOrigins: Readonly<Record<string, unknown>>
}) {
  // Create searchable items from all models
  const searchableItems = useMemo(
    () =>
      buildSearchableItems(providers, {
        hideProvider,
        selectedProvider,
        selectedModelId,
      }),
    [providers, hideProvider, selectedProvider, selectedModelId]
  )

  const ambiguousModelIds = useMemo(
    () => findAmbiguousModelIds(searchableItems),
    [searchableItems]
  )

  const disambiguation = useMemo(
    () => buildDisambiguation(searchableItems),
    [searchableItems]
  )

  const remoteLabel = useMemo(
    () => makeRemoteLabeler(searchableItems),
    [searchableItems]
  )

  // Get favorite models that are currently available
  const favoriteItems = useMemo(
    () =>
      searchableItems.filter((item) => isFavoriteItem(favoriteModels, item)),
    [searchableItems, favoriteModels]
  )

  // Filter models based on search value
  const filteredItems = useMemo(
    () => filterBySearch(searchableItems, searchValue),
    [searchableItems, searchValue]
  )

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
      (item) => !isFavoriteItem(favoriteModels, item)
    )
  }, [filteredItems, wantsFlatList, sort, lastUsed, favoriteModels, modelIsOffline])

  // With nothing to list, the provider sections are still worth showing: their
  // headers are how a user reaches a provider's settings to add a model.
  const isGrouped = !wantsFlatList || flatItems.length === 0

  // Group filtered items by provider, excluding favorites when not searching
  const groupedItems = useMemo(
    () =>
      buildPickerGroups({
        filteredItems,
        providers,
        searchValue,
        favoriteModels,
        unreachableOrigins,
        hideProvider,
        selectedProvider,
      }),
    [
      filteredItems,
      providers,
      searchValue,
      favoriteModels,
      unreachableOrigins,
      hideProvider,
      selectedProvider,
    ]
  )

  return {
    ambiguousModelIds,
    disambiguation,
    remoteLabel,
    favoriteItems,
    flatItems,
    isGrouped,
    groupedItems,
  }
}
