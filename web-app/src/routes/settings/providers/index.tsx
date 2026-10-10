import { FadeText } from '@/components/ui/fade-text'
import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useNavigate } from '@tanstack/react-router'
import {
  Copy,
  ExternalLink,
  Play,
  Square,
} from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { formatBytes, getDefaultProviderTitle, getProviderTitle } from '@/lib/utils'
import { AddProviderDialog } from '@/containers/dialogs'
import { ImportLlamacppModelDialog } from '@/containers/dialogs/ImportLlamacppModelDialog'
import { Switch } from '@/components/ui/switch'
import { Chip } from '@/components/ui/chip'
import { ProviderStatusChip } from '@/components/ProviderStatusChip'
import { providerKeyStatus } from '@/lib/providerKeyStatus'
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
  CapabilityChips,
  EnginePage,
  KpiRow,
  KpiTile,
  PageHead,
  SearchField,
  TBOX_ROW,
  TBox,
} from '@/containers/engine/EngineKit'
import { BrandMark } from '@/containers/engine/BrandMark'
import { LiveChart } from '@/containers/engine/LiveChart'
import { RowMenu } from '@/containers/engine/RowMenu'
import {
  ProviderCardMenu,
  RemoveProviderDialog,
  RenameProviderDialog,
} from '@/containers/engine/ProviderCardMenu'
import { useRemoveProvider } from '@/hooks/useRemoveProvider'
import { modelLogo, providerLogo } from '@/lib/brandLogos'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import {
  averageSpeeds,
  contextLengthOf,
  formatTps,
  isEngineProviderName,
  quantOf,
  recentSpeeds,
} from '@/lib/engineModels'
import { useEngineActivity } from '@/stores/engine-activity-store'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.model_providers as any)({
  component: ModelProviders,
})

type Filter = 'all' | 'local' | 'remote'

/** Installed-models table: logo, name, provider, capabilities, size, context, speed, status, menu. */
const MODEL_COLS =
  '30px minmax(0,1fr) 96px 112px 64px 68px 80px 104px 28px'

/** Card entrance delay: staggered, but capped so a long list is never waiting on its tail. */
const staggerDelay = (i: number) => 120 + Math.min(i, 8) * 25

/** How many recent replies the speed charts show. */
const SPEED_WINDOW = 24

function ModelProviders() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { providers, addProvider, updateProvider, setProviders } =
    useModelProvider()
  const stripReasoningFromContext = useGeneralSetting(
    (s) => s.stripReasoningFromContext
  )
  const setStripReasoningFromContext = useGeneralSetting(
    (s) => s.setStripReasoningFromContext
  )
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

  const toggleProvider = async (provider: ProviderObject, active: boolean) => {
    if (!active && provider.provider.toLowerCase() === 'llamacpp') {
      await serviceHub.models().stopAllModels()
    }
    updateProvider(provider.provider, { ...provider, active })
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
        toast.error(t('providerAlreadyExists', { name }))
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
    () =>
      visibleProviders
        .filter((p) => p.active)
        .flatMap((provider) =>
          provider.models.map((model) => ({
            provider,
            model,
            local: isEngineProviderName(provider.provider),
          }))
        ),
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

  const shownRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(
      (r) =>
        (filter === 'all' || (filter === 'local') === r.local) &&
        (!q ||
          r.model.id.toLowerCase().includes(q) ||
          (r.model.name ?? '').toLowerCase().includes(q) ||
          getProviderTitle(r.provider.provider).toLowerCase().includes(q))
    )
  }, [rows, filter, query])

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
                loadedRows.map(({ provider, model }) => {
                  const speed = speeds.get(model.id)
                  const series = recentSpeeds(generations, SPEED_WINDOW, model.id)
                  return (
                    <div
                      key={`${provider.provider}:${model.id}`}
                      data-testid={`loaded-row-${model.id}`}
                      className="flex items-center gap-3 border-b border-dashed border-border py-3 last:border-b-0"
                    >
                      <BrandMark
                        logo={modelLogo(model.id, provider.provider)}
                        name={model.name || model.id}
                        size={34}
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <b className="truncate text-[13px] font-medium text-foreground">
                          {model.name || model.id}
                        </b>
                        <small className="truncate text-xs text-muted-foreground">
                          {[
                            getProviderTitle(provider.provider),
                            fileSizes[model.id]
                              ? formatBytes(fileSizes[model.id])
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                        {maxSpeed > 0 && speed && (
                          <span className="h-1.5 w-full overflow-hidden rounded-full bg-track">
                            <i
                              className="block h-full rounded-full bg-grad motion-safe:animate-draw-x"
                              style={{ width: `${(speed.avg / maxSpeed) * 100}%` }}
                            />
                          </span>
                        )}
                      </div>
                      <div className="flex w-[110px] shrink-0 flex-col items-end gap-0.5 max-sm:hidden">
                        {series.length > 1 && (
                          <LiveChart series={series} compact format={formatTps} />
                        )}
                        {series.length > 0 && (
                          <small className="text-[11.5px] text-muted-foreground tabular-nums">
                            {formatTps(series[series.length - 1])}
                          </small>
                        )}
                        <small className="text-[11.5px] text-muted-foreground tabular-nums">
                          {speed ? formatTps(speed.avg) : t('engine:speed.noneYet')}
                        </small>
                      </div>
                      <Button
                        variant="surface"
                        size="sm"
                        className="pointer-coarse:h-11"
                        onClick={() => stopModel(model.id, provider.provider)}
                      >
                        {t('engine:loaded.unload')}
                      </Button>
                    </div>
                  )
                })
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

        <Frame className="motion-safe:animate-rise-in [animation-delay:300ms]">
          <FrameHeader
            icon={<Icon name="x-key" />}
            title={t('engine:providers.title')}
            actions={addProviderButton}
          />
          <FrameBody className="p-3">
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2.5">
              {visibleProviders.map((provider, i) => {
                const title = getProviderTitle(provider.provider)
                const local = isEngineProviderName(provider.provider)
                const setUp =
                  local || provider.models.length > 0 || providerHasRemoteApiKeys(provider)
                return (
                  <li
                    key={provider.provider}
                    data-testid={`provider-row-${provider.provider}`}
                    style={{ animationDelay: `${staggerDelay(i)}ms` }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenuFor(provider.provider)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                        e.preventDefault()
                        setMenuFor(provider.provider)
                      }
                    }}
                    className={cn(
                      'group relative flex flex-col items-start gap-1.5 rounded-xl border-[0.8px] border-border p-3 text-left transition-[transform,box-shadow] duration-300 ease-expo motion-safe:animate-rise-in',
                      provider.active
                        ? 'bg-card hover:-translate-y-0.5 hover:shadow-lift'
                        : 'bg-muted'
                    )}
                  >
                    <div className="mb-1 flex w-full items-start justify-between">
                      <BrandMark
                        logo={providerLogo(provider.provider)}
                        name={title}
                        size={40}
                        className={cn(!provider.active && 'opacity-60')}
                      />
                      <div className="flex items-center gap-1">
                        <ProviderCardMenu
                          provider={provider}
                          title={title}
                          open={menuFor === provider.provider}
                          onOpenChange={(o) => setMenuFor(o ? provider.provider : null)}
                          onEdit={() => openProvider(provider.provider)}
                          onToggle={() => void toggleProvider(provider, !provider.active)}
                          onRename={() => setRenaming(provider)}
                          onRemove={() => setPendingRemoval(provider)}
                        />
                        <Switch
                          className="relative z-10"
                          checked={provider.active}
                          aria-label={t('providers:useProvider', {
                            provider: title,
                          })}
                          onCheckedChange={(e) => void toggleProvider(provider, e)}
                        />
                      </div>
                    </div>
                    {provider.active ? (
                      <button
                        type="button"
                        onClick={() => openProvider(provider.provider)}
                        aria-label={t('providers:openProvider', { provider: title })}
                        className="min-w-0 max-w-full text-left text-[13.5px] font-semibold text-foreground outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/40"
                      >
                        <FadeText>{title}</FadeText>
                      </button>
                    ) : (
                      <FadeText as="b" className="max-w-full text-[13.5px] font-semibold text-foreground opacity-60">
                        {title}
                      </FadeText>
                    )}
                    <small className="text-xs text-muted-foreground">
                      {local ? t('engine:providers.onDevice') : t('engine:providers.remote')}
                      {' · '}
                      {setUp
                        ? t('engine:providers.modelsCount', { count: provider.models.length })
                        : t('engine:providers.notSetUp')}
                    </small>
                    {provider.active ? (
                      <ProviderStatusChip status={providerKeyStatus(provider)} />
                    ) : (
                      <Chip dot>{t('engine:status.off')}</Chip>
                    )}
                  </li>
                )
              })}
              {/* Enters after the last provider card, as part of the same stagger. */}
              <li
                className="motion-safe:animate-rise-in"
                style={{ animationDelay: `${staggerDelay(visibleProviders.length)}ms` }}
              >
                <AddProviderDialog onCreateProvider={createProvider}>
                  <button
                    type="button"
                    className="flex size-full min-h-[132px] flex-col items-center justify-center gap-1 rounded-xl border-[0.8px] border-dashed border-border-strong p-3 text-center text-muted-foreground transition-colors hover:bg-hover-row hover:text-foreground"
                  >
                    <Icon name="x-plus" />
                    <b className="text-[13px] font-medium">{t('engine:providers.custom')}</b>
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
                {shownRows.map(({ provider, model, local }) => {
                  const loaded = local && activeModels.includes(model.id)
                  const speed = speeds.get(model.id)
                  const ctx = contextLengthOf(model)
                  const hasKey = providerKeyStatus(provider) !== 'missing'
                  return (
                    <div
                      key={`${provider.provider}:${model.id}`}
                      data-testid={`models-row-${model.id}`}
                      className={cn(TBOX_ROW, 'motion-safe:animate-rise-in')}
                    >
                      <BrandMark
                        logo={modelLogo(model.id, provider.provider)}
                        name={model.name || model.id}
                        size={30}
                      />
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <FadeText as="b" className="text-[13px] font-medium text-foreground" title={model.id}>
                          {model.name || model.id}
                        </FadeText>
                        <FadeText as="small" className="font-mono text-[11px] text-subtle-foreground">
                          {model.id}
                        </FadeText>
                      </div>
                      <span className="min-w-0">
                        {/* The provider, never the quantization: a local id's
                            `:Q4_K_M` tag is already in the id under the name. */}
                        <Chip className="max-w-full" data-testid="models-provider-cell">
                          <span className="truncate">{getProviderTitle(provider.provider)}</span>
                        </Chip>
                      </span>
                      {/* Always a cell, even with no capabilities, so the
                          columns after it stay in place. */}
                      <span className="min-w-0 overflow-hidden" data-slot="caps-cell">
                        <CapabilityChips
                          iconOnly
                          className="flex-nowrap"
                          capabilities={model.capabilities ?? []}
                        />
                      </span>
                      <span className={cn('min-w-0 truncate tabular-nums', !local && 'text-muted-foreground')}>
                        {local
                          ? fileSizes[model.id]
                            ? formatBytes(fileSizes[model.id])
                            : '—'
                          : t('engine:table.remote')}
                      </span>
                      <span className="min-w-0 truncate tabular-nums">
                        {ctx ? ctx.toLocaleString() : '—'}
                      </span>
                      <span className="flex min-w-0 flex-col gap-1">
                        {speed && maxSpeed > 0 ? (
                          <>
                            <span className="h-1.5 w-full overflow-hidden rounded-full bg-track">
                              <i
                                className="block h-full rounded-full bg-grad motion-safe:animate-draw-x"
                                style={{ width: `${(speed.avg / maxSpeed) * 100}%` }}
                              />
                            </span>
                            <small className="text-[11px] text-muted-foreground tabular-nums">
                              {formatTps(speed.avg)}
                            </small>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </span>
                      <span className="min-w-0">
                        {local ? (
                          loaded ? (
                            <Chip tone="ok" live>
                              {t('engine:status.loaded')}
                            </Chip>
                          ) : (
                            <Chip dot>{t('engine:status.ready')}</Chip>
                          )
                        ) : hasKey ? (
                          <Chip tone="ok" dot>
                            {providerKeyStatus(provider) === 'keyless'
                              ? t('engine:status.keyless')
                              : t('engine:status.connected')}
                          </Chip>
                        ) : (
                          <Chip tone="warn" dot>
                            {t('engine:status.noKey')}
                          </Chip>
                        )}
                      </span>
                      <RowMenu
                        label={t('engine:menu.modelActions', { model: model.name || model.id })}
                        items={[
                          ...(local
                            ? [
                                loaded
                                  ? {
                                      label: t('engine:menu.stop'),
                                      icon: <Square />,
                                      onSelect: () => stopModel(model.id, provider.provider),
                                    }
                                  : {
                                      label: t('engine:menu.start'),
                                      icon: <Play />,
                                      onSelect: () => void startModel(provider, model.id),
                                    },
                              ]
                            : []),
                          {
                            label: t('engine:menu.openProvider'),
                            icon: <ExternalLink />,
                            onSelect: () => openProvider(provider.provider),
                          },
                          {
                            label: t('engine:menu.copyId'),
                            icon: <Copy />,
                            onSelect: () => {
                              void navigator.clipboard
                                ?.writeText(model.id)
                                .then(() => toast.success(t('engine:menu.copied')))
                                .catch(() => {})
                            },
                          },
                        ]}
                      />
                    </div>
                  )
                })}
              </TBox>
            )}
          </FrameBody>
        </Frame>

        <Frame className="motion-safe:animate-rise-in [animation-delay:400ms]">
          <FrameHeader title={t('provider:globalSettings')} />
          <FrameBody className="px-3">
            <div className="flex items-center justify-between gap-6 py-3.5">
              <div className="flex min-w-0 flex-col gap-1.5">
                <b className="text-[13px] font-medium text-foreground">
                  {t('provider:stripReasoning')}
                </b>
                <small className="max-w-[60ch] text-xs leading-snug text-muted-foreground">
                  {t('provider:stripReasoningDesc')}
                </small>
              </div>
              <Switch
                aria-label={t('provider:stripReasoning')}
                checked={stripReasoningFromContext}
                onCheckedChange={setStripReasoningFromContext}
              />
            </div>
          </FrameBody>
        </Frame>
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
