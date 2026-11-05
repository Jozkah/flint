import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useNavigate } from '@tanstack/react-router'
import {
  Power,
} from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { formatBytes, getDefaultProviderTitle, getProviderTitle } from '@/lib/utils'
import { AddProviderDialog } from '@/containers/dialogs'
import { markFirstModelFetch } from '@/lib/pendingFirstModelFetch'
import { ImportLlamacppModelDialog } from '@/containers/dialogs/ImportLlamacppModelDialog'
import { Chip } from '@/components/ui/chip'
import { useBedrockCredentials } from '@/hooks/useBedrockCredentials'
import { Segmented } from '@/components/ui/segmented'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  openAIProviderSettings,
  anthropicProviderSettings,
} from '@/constants/providers'
import cloneDeep from 'lodash/cloneDeep'
import { toast } from 'sonner'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useAppState } from '@/hooks/useAppState'
import {
  SettingsPageHeader,
  SettingsWithSections,
} from '@/containers/SettingsPageHeader'
import {
  EnginePage,
  KpiRow,
  KpiTile,
  PageHead,
  SearchField,
  TBox,
} from '@/containers/engine/EngineKit'
import { LiveChart } from '@/containers/engine/LiveChart'
import {
  RemoveProviderDialog,
  RenameProviderDialog,
} from '@/containers/engine/ProviderCardMenu'
import { useRemoveProvider } from '@/hooks/useRemoveProvider'
import {
  averageSpeeds,
  formatTps,
  quantOf,
  recentSpeeds,
} from '@/lib/engineModels'
import { useEngineActivity } from '@/stores/engine-activity-store'
import { SettingsTabStrip, useSettingsTab } from '@/containers/SettingsTabs'
import { ModelDefaultsCard } from '@/containers/ModelDefaultsCard'
import { ModelsTableRow } from '@/containers/engine/ModelsTableRow'
import { ProviderCard } from '@/containers/engine/ProviderCard'
import { LoadedModelRow } from '@/containers/engine/LoadedModelRow'
import { buildModelRows, filterModelRows, type ModelFilter } from '@/lib/modelTableRows'


export const Route = createFileRoute('/settings/providers/')({
  component: ModelProviders,
})

type Filter = ModelFilter

type OverviewTab = 'overview' | 'providers' | 'defaults'

/** Installed-models table: logo, name, provider, capabilities, size, context, speed, status, menu.
 *  The name keeps 140px however narrow the window: at minmax(0,1fr) it was the
 *  one column that gave way and the names vanished at 480px (T7-089). */
const MODEL_COLS =
  '30px minmax(140px,1fr) 96px 112px 64px 68px 80px minmax(104px,max-content) 28px'

/** How many recent replies the speed charts show. */
const SPEED_WINDOW = 24

function ModelProviders() {
  const bedrockCredentials = useBedrockCredentials((state) => state.saved)
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { providers, addProvider, updateProvider, setProviders } =
    useModelProvider()
  const navigate = useNavigate()
  const activeModels = useAppState((s) => s.activeModels) ?? []
  const setActiveModels = useAppState((s) => s.setActiveModels)
  const generations = useEngineActivity((s) => s.generations)
  const [fileSizes, setFileSizes] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<ProviderObject | null>(
    null
  )
  const removeProvider = useRemoveProvider()
  const [renaming, setRenaming] = useState<ProviderObject | null>(null)
  const pageTabs = [
    { id: 'overview' as OverviewTab, label: t('common:shell.overview') },
    {
      id: 'providers' as OverviewTab,
      label: t('engine:tabs.providersAndModels', {
        defaultValue: 'Providers and models',
      }),
    },
    {
      id: 'defaults' as OverviewTab,
      label: t('engine:tabs.defaults', { defaultValue: 'Defaults' }),
      anchors: ['settings-model-providers-*'],
    },
  ]
  const [pageTab, setPageTab] = useSettingsTab<OverviewTab>(pageTabs)

  const toggleProvider = async (provider: ProviderObject, active: boolean) => {
    const engine = provider.provider.toLowerCase()
    if (!active && (engine === 'llamacpp' || engine === 'mlx')) {
      const loaded = await serviceHub.models().getActiveModels(engine)
      await Promise.all(
        loaded.map((model) => serviceHub.models().stopModel(model, engine))
      )
      setActiveModels((await serviceHub.models().getActiveModels()) || [])
    }
    updateProvider(provider.provider, { ...provider, active })
  }

  const anyActive = providers.some((p) => p.active)
  const setAllProviders = async (active: boolean) => {
    if (!active) await serviceHub.models().stopAllModels()
    for (const p of providers) {
      if (p.active !== active) updateProvider(p.provider, { ...p, active })
    }
    toast.success(
      t(active ? 'engine:providers.allEnabledToast' : 'engine:providers.allDisabledToast')
    )
  }

  const confirmRemoval = () => {
    const provider = pendingRemoval
    if (!provider) return
    setPendingRemoval(null)
    void removeProvider(provider).then(() =>
      toast.success(
        t('providers:removeProvider.success', {
          provider: getProviderTitle(provider.provider),
        })
      )
    )
  }

  const visibleProviders = useMemo(
    () =>
      (providers ?? []).filter((p) => IS_MACOS || p.provider !== 'mlx'),
    [providers]
  )

  const refreshActive = useCallback(() => {
    const models = serviceHub.models?.()
    if (!models?.getActiveModels) return
    void Promise.resolve(models.getActiveModels())
      .then((list) => setActiveModels?.(list || []))
      .catch(() => {})
  }, [serviceHub, setActiveModels])

  useEffect(() => {
    refreshActive()
  }, [refreshActive])

  // Model file sizes for the disk figure and the size column. Read-only; the
  // page renders without them.
  const modelCount = visibleProviders.reduce((n, p) => n + p.models.length, 0)
  useEffect(() => {
    const models = serviceHub.models?.() as
      | { fetchModels?: () => Promise<{ id: string; sizeBytes?: number }[]> }
      | undefined
    if (typeof models?.fetchModels !== 'function') return
    let cancelled = false
    Promise.resolve()
      .then(() => models.fetchModels!())
      .then((infos) => {
        if (cancelled) return
        const next: Record<string, number> = {}
        for (const info of infos ?? []) {
          if (info.sizeBytes) next[info.id] = info.sizeBytes
        }
        setFileSizes(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [serviceHub, modelCount])

  const createProvider = useCallback(
    (
      name: string,
      baseUrl: string,
      apiKey: string,
      apiType: ProviderApiType
    ) => {
      if (
        providers.some((e) => e.provider.toLowerCase() === name.toLowerCase())
      ) {
        toast.error(t('common:providerAlreadyExists', { name }))
        return
      }
      const template =
        apiType === 'anthropic'
          ? anthropicProviderSettings
          : openAIProviderSettings
      const settings = cloneDeep(template) as ProviderSetting[]
      for (const s of settings) {
        if (s.key === 'base-url') {
          (s.controller_props as { value: string }).value = baseUrl
        } else if (s.key === 'api-key') {
          (s.controller_props as { value: string }).value = apiKey
        }
      }
      const newProvider: ProviderObject = {
        provider: name,
        active: true,
        models: [],
        settings,
        api_key: apiKey,
        base_url: baseUrl,
        ...(apiType === 'anthropic' ? { api_type: 'anthropic' as const } : {}),
      }
      addProvider(newProvider)
      markFirstModelFetch(name)
      setTimeout(() => {
        navigate({
          to: route.settings.providers,
          params: {
            providerName: name,
          },
        })
      }, 0)
    },
    [providers, addProvider, t, navigate]
  )

  const openProvider = (providerName: string) =>
    navigate({
      to: route.settings.providers,
      params: { providerName },
    })

  const startModel = async (provider: ProviderObject, modelId: string) => {
    try {
      await serviceHub.models().startModel(provider, modelId)
      refreshActive()
    } catch (error) {
      toast.error(t('engine:models.startFailed', { model: modelId }), {
        description: String(error),
      })
    }
  }

  const stopModel = (modelId: string, provider?: string) => {
    void Promise.resolve(serviceHub.models().stopModel(modelId, provider))
      .catch((error) => console.error('Error stopping model:', error))
      .finally(refreshActive)
  }

  // Every model of an enabled provider, with where it runs.
  const rows = useMemo(
    () => buildModelRows(visibleProviders),
    [visibleProviders]
  )
  const localCount = rows.filter((r) => r.local).length
  const remoteCount = rows.length - localCount
  const loadedRows = rows.filter(
    (r) => r.local && activeModels.includes(r.model.id)
  )
  const diskBytes = rows.reduce(
    (sum, r) => (r.local ? sum + (fileSizes[r.model.id] ?? 0) : sum),
    0
  )
  const speeds = useMemo(() => averageSpeeds(generations), [generations])
  const fastest = useMemo(() => {
    let best: { model: string; avg: number } | null = null
    for (const [model, { avg }] of speeds) {
      if (!best || avg > best.avg) best = { model, avg }
    }
    return best
  }, [speeds])
  const maxSpeed = fastest?.avg ?? 0
  const fastestLabel = (id: string) => {
    const row = rows.find((r) => r.model.id === id)
    const name = row?.model.name || id
    const quant = quantOf(id)
    return quant && !name.includes(quant) ? `${name} · ${quant}` : name
  }

  const shownRows = useMemo(
    () => filterModelRows(rows, filter, query),
    [rows, filter, query]
  )

  const llamacpp = visibleProviders.find((p) => p.provider === 'llamacpp')
  const refreshProviders = () =>
    serviceHub
      .providers()
      .getProviders()
      .then(setProviders)
      .catch(() => {})

  const addProviderButton = (
    <AddProviderDialog onCreateProvider={createProvider}>
      <Button variant="outline" size="sm" className="pointer-coarse:h-11">
        <Icon name="x-plus" size={14} />
        <span>{t('provider:addProvider')}</span>
      </Button>
    </AddProviderDialog>
  )

  return (
    <div className="flex h-full w-full flex-col">
      <SettingsPageHeader title={t('engine:models.title')} />
      <SettingsWithSections>
      <EnginePage testId="models-page">
        <PageHead
          title={t('engine:models.title')}
          description={t('engine:models.description')}
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
                onClick={() => navigate({ to: route.hub.index })}
              >
                <Icon name="search" size={14} />
                {t('engine:models.browseHuggingFace')}
              </Button>
              {llamacpp && (
                <ImportLlamacppModelDialog
                  provider={llamacpp}
                  onSuccess={() => void refreshProviders()}
                  trigger={
                    <Button variant="outline" size="sm" className="pointer-coarse:h-11">
                      <Icon name="x-download" size={14} />
                      {t('engine:models.importGguf')}
                    </Button>
                  }
                />
              )}
            </>
          }
        />

        <SettingsTabStrip<OverviewTab>
          tabs={pageTabs}
          value={pageTab}
          onChange={setPageTab}
          label={t('engine:models.title')}
        />

        {pageTab === 'overview' && (
        <>
        <KpiRow>
          <KpiTile
            title={t('engine:kpi.installed')}
            icon={<Icon name="x-cube" />}
            value={localCount}
            sub={t('engine:kpi.remoteAvailableSub', { count: remoteCount })}
            delay={40}
          />
          <KpiTile
            title={t('engine:kpi.loaded')}
            icon={<Icon name="x-cpu" />}
            value={loadedRows.length}
            sub={t('engine:kpi.loadedSub', { count: localCount })}
            delay={90}
          />
          <KpiTile
            title={t('engine:kpi.disk')}
            icon={<Icon name="x-disk" />}
            value={diskBytes > 0 ? formatBytes(diskBytes) : '—'}
            sub={t('engine:kpi.diskSub', { count: localCount })}
            delay={140}
          />
          <KpiTile
            title={t('engine:kpi.fastest')}
            icon={<Icon name="zap" />}
            value={fastest ? formatTps(fastest.avg) : '—'}
            sub={fastest ? fastestLabel(fastest.model) : t('engine:kpi.fastestNone')}
            delay={190}
          />
        </KpiRow>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Frame className="motion-safe:animate-rise-in [animation-delay:220ms]">
            <FrameHeader
              icon={<Icon name="x-cpu" />}
              title={t('engine:loaded.title')}
              actions={
                loadedRows.length > 0 ? (
                  <Chip tone="ok" live>
                    {t('engine:live')}
                  </Chip>
                ) : undefined
              }
            />
            <FrameBody className="px-3 py-1">
              {loadedRows.length === 0 ? (
                <EmptyState
                  icon={<Icon name="x-cpu" />}
                  title={t('engine:loaded.empty')}
                  description={t('engine:loaded.emptyHint')}
                />
              ) : (
                loadedRows.map(({ provider, model }) => (
                  <LoadedModelRow
                    key={`${provider.provider}:${model.id}`}
                    provider={provider}
                    model={model}
                    fileSize={fileSizes[model.id]}
                    speedAvg={speeds.get(model.id)?.avg}
                    maxSpeed={maxSpeed}
                    series={recentSpeeds(generations, SPEED_WINDOW, model.id)}
                    onUnload={() => stopModel(model.id, provider.provider)}
                  />
                ))
              )}
            </FrameBody>
          </Frame>

          <Frame className="motion-safe:animate-rise-in [animation-delay:260ms]">
            <FrameHeader icon={<Icon name="zap" />} title={t('engine:speed.title')} />
            <FrameBody className="justify-center p-3">
              {generations.length === 0 ? (
                <EmptyState
                  icon={<Icon name="zap" />}
                  title={t('engine:speed.empty')}
                  description={t('engine:speed.emptyHint')}
                />
              ) : (
                <LiveChart
                  series={recentSpeeds(generations, SPEED_WINDOW)}
                  label={t('engine:speed.label')}
                  format={formatTps}
                  windowLabel={t('engine:speed.window', {
                    count: Math.min(SPEED_WINDOW, generations.length),
                  })}
                  peakLabel={t('engine:chart.peak')}
                  avgLabel={t('engine:chart.avg')}
                  plotClassName="h-[110px]"
                />
              )}
            </FrameBody>
          </Frame>
        </div>
        </>
        )}

        {pageTab === 'providers' && (
        <>
        <Frame className="motion-safe:animate-rise-in [animation-delay:300ms]">
          <FrameHeader
            icon={<Icon name="x-key" />}
            title={t('engine:providers.title')}
            actions={
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="pointer-coarse:h-11"
                  disabled={providers.length === 0}
                  onClick={() => void setAllProviders(!anyActive)}
                >
                  <Power aria-hidden />
                  {t(anyActive ? 'engine:providers.disableAll' : 'engine:providers.enableAll')}
                </Button>
                {addProviderButton}
              </>
            }
          />
          <FrameBody className="p-3">
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2.5">
              {visibleProviders.map((provider) => (
                <ProviderCard
                  key={provider.provider}
                  provider={provider}
                  menuOpen={menuFor === provider.provider}
                  onMenuOpenChange={(o) => setMenuFor(o ? provider.provider : null)}
                  onOpenMenu={() => setMenuFor(provider.provider)}
                  onOpenProvider={() => openProvider(provider.provider)}
                  onToggle={(active) => void toggleProvider(provider, active)}
                  onRename={() => setRenaming(provider)}
                  onRemove={() => setPendingRemoval(provider)}
                />
              ))}
              <li className="motion-safe:animate-rise-in">
                <AddProviderDialog onCreateProvider={createProvider}>
                  <button
                    type="button"
                    className="flex size-full min-h-[132px] flex-col items-center justify-center gap-1 rounded-xl border-[0.8px] border-dashed border-border-strong p-3 text-center text-muted-foreground transition-colors hover:bg-hover-row hover:text-foreground"
                  >
                    <Icon name="x-plus" />
                    <b className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium">{t('engine:providers.custom')}</b>
                    <small className="text-xs">{t('engine:providers.customHint')}</small>
                  </button>
                </AddProviderDialog>
              </li>
            </ul>
          </FrameBody>
        </Frame>

        <Frame className="motion-safe:animate-rise-in [animation-delay:360ms]">
          <FrameHeader
            icon={<Icon name="x-cube" />}
            title={t('engine:installed.title')}
            actions={
              <div className="flex items-center gap-2">
                <Segmented<Filter>
                  className="w-[220px]"
                  size="sm"
                  aria-label={t('engine:installed.filter')}
                  value={filter}
                  onValueChange={setFilter}
                  options={[
                    { value: 'all', label: t('engine:filter.all') },
                    { value: 'local', label: t('engine:filter.local') },
                    { value: 'remote', label: t('engine:filter.remote') },
                  ]}
                />
                <SearchField
                  className="hidden w-[180px] sm:flex"
                  value={query}
                  onChange={setQuery}
                  placeholder={t('engine:installed.search')}
                />
              </div>
            }
          />
          <FrameBody className="p-3">
            {shownRows.length === 0 ? (
              <EmptyState
                icon={<Icon name="x-cube" />}
                title={
                  rows.length === 0
                    ? t('engine:installed.none')
                    : t('engine:installed.noMatch')
                }
                description={
                  rows.length === 0 ? t('engine:installed.noneHint') : undefined
                }
              />
            ) : (
              <TBox
                columns={MODEL_COLS}
                stackOnPhone
                head={[
                  '',
                  t('engine:table.name'),
                  t('engine:table.provider'),
                  t('engine:table.capabilities'),
                  t('engine:table.size'),
                  t('engine:table.context'),
                  t('engine:table.speed'),
                  t('engine:table.status'),
                  '',
                ]}
              >
                {shownRows.map(({ provider, model, local }) => (
                  <ModelsTableRow
                    key={`${provider.provider}:${model.id}`}
                    provider={provider}
                    model={model}
                    local={local}
                    loaded={local && activeModels.includes(model.id)}
                    fileSize={fileSizes[model.id]}
                    speedAvg={speeds.get(model.id)?.avg}
                    maxSpeed={maxSpeed}
                    keyOptions={{ bedrockCredentials }}
                    onStart={() => void startModel(provider, model.id)}
                    onStop={() => stopModel(model.id, provider.provider)}
                    onOpenProvider={() => openProvider(provider.provider)}
                  />
                ))}
              </TBox>
            )}
          </FrameBody>
        </Frame>
        </>
        )}

        {pageTab === 'defaults' && (
          <ModelDefaultsCard />
        )}

        <RenameProviderDialog
          provider={renaming}
          defaultTitle={renaming ? getDefaultProviderTitle(renaming.provider) : ''}
          onOpenChange={(o) => !o && setRenaming(null)}
          onSave={(displayName) => {
            if (renaming) updateProvider(renaming.provider, { displayName })
            setRenaming(null)
          }}
        />
        <RemoveProviderDialog
          provider={pendingRemoval}
          title={pendingRemoval ? getProviderTitle(pendingRemoval.provider) : ''}
          onOpenChange={(o) => !o && setPendingRemoval(null)}
          onConfirm={confirmRemoval}
        />
      </EnginePage>
      </SettingsWithSections>
    </div>
  )
}
