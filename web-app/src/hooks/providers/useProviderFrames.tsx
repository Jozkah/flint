import type { JSX } from 'react'
import {
  SPEED_WINDOW,
  ENGINE_BASIC_KEYS,
  type DetailTab,
} from './providerDetailShared'
/* eslint-disable @typescript-eslint/no-explicit-any */
import { CardItem } from '@/containers/Card'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  cn,
  formatBytes,
  getProviderTitle,
  getModelDisplayName,
  isLocalProvider,
} from '@/lib/utils'
import { Link } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { DynamicControllerSetting } from '@/containers/dynamicControllerSetting'
import {
  CONTEXT_SIZE_MIN,
  CONTEXT_SIZE_STEPS,
} from '@/lib/steppedValue'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { LlamacppEngineInfo } from '@/containers/LlamacppEngineInfo'
import { SkippedLinkedModelsNotice } from '@/containers/SkippedLinkedModelsNotice'
import DeleteProvider from '@/containers/dialogs/DeleteProvider'
import {
  ChevronDown,
  Info,
  } from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { toast } from 'sonner'
import {
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { providerRemoteApiKeyChain } from '@/lib/provider-api-keys'
import { errorText } from '@/lib/errorText'
import { Chip } from '@/components/ui/chip'
import { MiddleText } from '@/components/ui/middle-text'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ENGINE_SETTINGS_WITH_INFO,
  localizeEngineSetting,
} from '@/lib/engineSettingsText'
import { parseModelName } from '@/lib/modelDisplayName'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { CapabilityChips, TBOX_ROW } from '@/containers/engine/EngineKit'
import { BrandMark } from '@/containers/engine/BrandMark'
import { ProviderModelsFrame } from '@/containers/providers/ProviderModelsFrame'
import { type LocalFileInfo } from '@/containers/providers/providerTable'
import { ProviderApiFrame } from '@/containers/providers/ProviderApiFrame'
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
import { useSettingsTab } from '@/containers/SettingsTabs'
import {
  contextColumn,
  useLoadedContextWindows,
} from '@/hooks/useLoadedContextWindows'
import { startOfToday } from '@/stores/engine-activity-store'
import { isMemorySetting } from '@/lib/providerDetailHelpers'
import type { Disambiguation } from '@/lib/modelDisplayName'
import type { GenerationSample } from '@/stores/engine-activity-store'
import type { ServiceHub } from '@/services'
import type { RefObject } from 'react'
import type { Dispatch } from 'react'
import type { SetStateAction } from 'react'

export type ProviderFramesArgs = {
  isEngineProvider: boolean
  provider: ModelProvider | undefined
  activeModels: string[]
  localFiles: Record<string, LocalFileInfo>
  disambiguation: Map<string, Disambiguation>
  t: (key: string, options?: Record<string, unknown>) => string
  renderStatus: (modelId: string) => JSX.Element | null
  providerName: string
  generations: GenerationSample[]
  isPredefinedProvider: boolean
  serviceHub: ServiceHub
  updateProvider: (providerName: string, data: Partial<ModelProvider>) => void
  restartTimerRef: RefObject<NodeJS.Timeout | null>
  pendingRestartRef: RefObject<(() => void) | null>
  stopProviderModels: (name: string) => Promise<void>
  handleRefreshModels: () => Promise<void>
  refreshingModels: boolean
  handleModelImportSuccess: (importedModelName?: string) => Promise<void>
  canFilterModels: boolean
  modelQuery: string
  setModelQuery: (query: string) => void
  allModels: any
  filteredModels: any
  isLlamacpp: boolean
  embeddingModels: any
  chatModels: any
  modelEntries: any
  toggleGroup: (provider: string, group: string) => void
  handleStopModel: (modelId: string) => void
  loadingModels: string[]
  handleStartModel: (modelId: string) => Promise<void>
  handleRevealModelFile: (filePath: string) => Promise<void>
  defaultEmbeddingModelId: string | undefined
  setDefaultEmbeddingModel: (provider: string, modelId: string) => void
  modelLimit: number
  setModelLimit: Dispatch<SetStateAction<number>>
  importingModel: string | null
  baseUrlDraft: string
  setBaseUrlDraft: Dispatch<SetStateAction<string>>
  commitBaseUrlDraft: () => void
  apiVersionDraft: string
  setApiVersionDraft: Dispatch<SetStateAction<string>>
  commitApiVersionDraft: () => void
  showAdvancedApiKeys: boolean
  primaryKeyDraft: string
  setPrimaryKeyDraft: (nextPrimary: string) => void
  commitApiKeysDraft: () => void
  setShowAdvancedApiKeys: Dispatch<SetStateAction<boolean>>
  setKeyCheckResults: Dispatch<SetStateAction<{ index: number; masked: string; status: string; detail: string; }[]>>
  handleTestApiKeys: () => Promise<void>
  isTestingKeys: boolean
  advancedApiKeyLines: string[]
  keyCheckResults: { index: number; masked: string; status: string; detail: string; }[]
  setKeyAtIndex: (index: number, nextValue: string) => void
  removeKeyLine: (index: number) => void
  addKeyLine: () => void
}

export function useProviderFrames({
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
}: ProviderFramesArgs) {

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
    <ProviderApiFrame
  provider={provider}
  baseUrlDraft={baseUrlDraft}
  setBaseUrlDraft={setBaseUrlDraft}
  commitBaseUrlDraft={commitBaseUrlDraft}
  apiVersionDraft={apiVersionDraft}
  setApiVersionDraft={setApiVersionDraft}
  commitApiVersionDraft={commitApiVersionDraft}
  showAdvancedApiKeys={showAdvancedApiKeys}
  primaryKeyDraft={primaryKeyDraft}
  setPrimaryKeyDraft={setPrimaryKeyDraft}
  commitApiKeysDraft={commitApiKeysDraft}
  setShowAdvancedApiKeys={setShowAdvancedApiKeys}
  setKeyCheckResults={setKeyCheckResults}
  handleTestApiKeys={handleTestApiKeys}
  isTestingKeys={isTestingKeys}
  advancedApiKeyLines={advancedApiKeyLines}
  keyCheckResults={keyCheckResults}
  setKeyAtIndex={setKeyAtIndex}
  removeKeyLine={removeKeyLine}
  addKeyLine={addKeyLine}
/>
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
  return {
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
  }
}
