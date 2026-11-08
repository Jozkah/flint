import {
  useEffect,
  useState,
  useRef,
  useMemo,
  useCallback,
  memo,
} from 'react'
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
import { modelNameTail } from '@/lib/modelDisplayName'
import { locationKind, type SearchableModel } from '@/lib/modelPickerItems'
import { useModelPickerKeyNav } from '@/hooks/useModelPickerKeyNav'
import { MiddleText } from '@/components/ui/middle-text'
import { effectiveContextLength } from '@/lib/engineModels'
import { classifyModelLocation } from '@/lib/modelLocation'
import {
  ArrowUpDown,
  Search,
  Settings,
  X,
} from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useThreads } from '@/hooks/useThreads'
import { selectionForThreadModel, useConversationPane } from '@/hooks/useConversationPane'
import { ModelSetting } from '@/containers/ModelSetting'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { ModelAvatar } from '@/containers/ModelAvatar'
import { ModelSupportStatus } from '@/containers/ModelSupportStatus'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { useProviderReachability } from '@/hooks/useProviderReachability'
import { useHideUnavailable } from '@/hooks/useProviderUnavailable'
import { ModelFilterButton } from '@/containers/ModelFilterButton'
import { isOffline, modelAvailability } from '@/lib/modelAvailability'
import { providerHasRemoteApiKeys as hasRemoteKeys } from '@/lib/provider-api-keys'
import { useModelOrder } from '@/hooks/useModelOrder'
import { MODEL_SORT_OPTIONS, type ModelSortOption } from '@/lib/modelSort'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useServiceHub } from '@/hooks/useServiceHub'
import { ChevronsUpDown } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ProcessingLocationLabel } from '@/containers/dropdownModelParts'
import {
  SECTION_HEADING,
  SORT_LABEL_KEYS,
  setLastUsedModel,
} from '@/containers/dropdownModelConsts'
import {
  useCheckModelVisionCapability,
  useInitializeModelSelection,
  useLlamacppVisionProbe,
  useModelPickerLists,
} from '@/containers/dropdownModelHooks'
import { renderModelPickerRow } from '@/containers/dropdownModelRow'

type DropdownModelProviderProps = {
  model?: ThreadModel
  useLastUsedModel?: boolean
  /**
   * Where a choice is recorded, in place of the current chat thread. Cowork
   * passes its session's setter, so a choice belongs to the session in view
   * and to no other (janhq/jan#8905).
   */
  onModelChange?: (model: ThreadModel) => void
  /** `quiet` under a composer: the model's name as text, no box, no arrow. */
  variant?: 'pill' | 'quiet'
}

// `offersModels` (the rule for which providers appear in a model picker) is
// shared with the Rooms participant picker so every surface offers the same
// providers. See `@/lib/providerOffers`.

const DropdownModelProvider = memo(function DropdownModelProvider({
  model,
  useLastUsedModel = false,
  onModelChange,
  variant = 'pill',
}: DropdownModelProviderProps) {
  const quiet = variant === 'quiet'
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
  const updateCurrentThreadModel = useThreads((s) => s.updateCurrentThreadModel)
  const updateThreadModel = useThreads((s) => s.updateThreadModel)
  // In a split conversation each pane shows, and changes, its own thread's
  // model only. No pane moves the global picker, which new chats and a
  // conversation shown on its own read.
  const pane = useConversationPane()
  // Only the pane's own thread model: a title change elsewhere must not
  // re-render every picker.
  const paneThreadModelRaw = useThreads((s) =>
    pane?.isSplit ? s.threads[pane.threadId]?.model : undefined
  )
  const inSplitPane = Boolean(pane?.isSplit)
  // A caller that passes `onModelChange` keeps the choice itself (Cowork
  // records it on its session). Such a picker shows and changes that caller's
  // model only; writing it into the global store too would silently change
  // the model every ordinary chat uses, and the store is persisted.
  const ownsSelection = Boolean(onModelChange)
  const drivesGlobalSelection =
    !ownsSelection && !pane?.isSplit
  const paneThreadModel = paneThreadModelRaw
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
  const hideProvider = useHideUnavailable()

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
  const pickerRef = useRef<HTMLDivElement>(null)

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
  // The window the model runs with: its own, else the provider's Default
  // context size (C043), else the engine's 8192 cap.
  const getContextSize = useCallback((): number => {
    if (!selectedModel) return 8192
    return (
      effectiveContextLength(selectedModel, getProviderByName(selectedProvider)) ??
      8192
    )
  }, [selectedModel, selectedProvider, getProviderByName])

  // Function to check if a llamacpp model has vision capabilities and update model capabilities
  const checkAndUpdateModelVisionCapability = useCheckModelVisionCapability(
    getProviderByName,
    updateProvider,
    serviceHub
  )

  // Initialize model provider - avoid race conditions with manual selections.
  useInitializeModelSelection({
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
  })

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

  // Check vision capabilities for all llamacpp models
  useLlamacppVisionProbe(open, providers, checkAndUpdateModelVisionCapability)

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

  const {
    ambiguousModelIds,
    disambiguation,
    remoteLabel,
    favoriteItems,
    flatItems,
    isGrouped,
    groupedItems,
  } = useModelPickerLists({
    providers,
    hideProvider,
    selectedProvider,
    selectedModelId: selectedModel?.id,
    favoriteModels,
    searchValue,
    sort,
    lastUsed,
    modelIsOffline,
    unreachableOrigins,
  })

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

  const onPickerKeyDown = useModelPickerKeyNav(pickerRef, searchInputRef)

  const renderRow = (item: SearchableModel, list: 'fav' | 'flat' | 'group') =>
    renderModelPickerRow(item, list, {
      selectedModel,
      selectedProvider,
      disambiguation,
      modelIsOffline,
      ambiguousModelIds,
      remoteLabel,
      t,
      handleSelect,
    })

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
          <div
            data-slot="model-pill"
            data-variant={variant}
            className={cn(
              'relative z-20 flex min-w-0 max-w-full shrink items-center pointer-coarse:h-11',
              quiet
                ? 'h-7 gap-1.5 rounded-md px-2 text-xs transition-colors duration-150 hover:bg-hover-row data-[state=open]:bg-hover-row'
                : 'h-[30px] gap-[7px] rounded-lg border-[0.8px] border-border bg-card px-2 text-[length:calc(var(--ui-font-base)*0.78125)] transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-lift data-[state=open]:border-border-strong data-[state=open]:shadow-lift'
            )}
          >
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
                      'min-w-0 flex-1 truncate text-left leading-normal',
                      quiet ? 'font-medium text-muted-foreground' : 'text-foreground',
                      !selectedModel?.id && 'text-muted-foreground'
                    )}
                    data-unavailable={
                      !selectedModel?.id && unavailableModel ? '' : undefined
                    }
                  >
                    <MiddleText
                      text={displayModel}
                      tail={modelNameTail(displayModel)}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{displayModel}</TooltipContent>
              </Tooltip>
              {!quiet && (
                <ChevronsUpDown className="size-[13px] shrink-0 text-muted-foreground" />
              )}
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
                  // Under a composer the row stays quiet; the settings still open
                  // from the status dot's "adjust settings" and the Models page.
                  hideTrigger={quiet}
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
          // Width rule: the popover matches the pill it opens from. A pill
          // narrower than 280px (a short name under the composer) gets the
          // 280px floor so rows stay readable; never wider than the viewport.
          // Cap height so the popover never overflows the viewport even when
          // it cannot flip to the other side.
          'w-[max(280px,var(--radix-popover-trigger-width))] max-w-[calc(100vw-24px)] max-h-[calc(100vh-16px)] p-1.5',
          searchValue.length === 0 && 'h-[26rem]'
        )}
        align="end"
        side="bottom"
        avoidCollisions
      >
        <div
          ref={pickerRef}
          className="flex flex-col size-full"
          onKeyDown={onPickerKeyDown}
        >
          {/* Search input */}
          <div className="flex items-center gap-2 border-b border-dashed border-border px-2 pt-1.5 pb-2">
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={searchInputRef}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder={t('common:searchModels')}
              className="min-w-0 flex-1 bg-transparent text-base font-normal text-foreground outline-0 placeholder:text-muted-foreground md:text-[length:calc(var(--ui-font-base)*0.8125)]"
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
            <ModelFilterButton />
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
