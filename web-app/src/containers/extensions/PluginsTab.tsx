import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  FolderOpen,
  Info,
  Loader2,
  OctagonAlert,
  Plus,
  Power,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'
import { invalidateSkills } from '@/hooks/useSkills'
import {
  checkGitUrl,
  getPluginDetails,
  getPluginSources,
  installPlugin,
  listPlugins,
  pluginErrorText,
  removePlugin,
  searchPlugins,
  setPluginEnabled,
  toPluginError,
  urlHost,
  type InstallSource,
  type InstalledPlugin,
  type MarketEntry,
  type PluginDetails,
  type PluginSourceKind,
  type PluginSources,
} from '@/lib/pluginStore'
import EnablementGrid from '@/containers/extensions/EnablementGrid'
import {
  getMatrix,
  listProjects,
  type ExtensionsMatrix,
  type ProjectEntry,
} from '@/lib/extensionsStore'
import { Icon } from '@/components/ui/icon'
import { ExtensionIcon, extensionIcon } from '@/containers/extensions/ExtensionIcon'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { RowMenu } from '@/containers/engine/RowMenu'

const ALERT = 'flex items-start gap-1.5 text-xs text-destructive break-words'

/**
 * Manage plugins installed in the user's global plugin store (shared by
 * every workspace, not one project's folder), plus a marketplace browse
 * panel to discover and install new ones. Lifts the list/details/install/
 * remove flow out of `PluginsManagerDialog` for `scope: 'global'`.
 */
export default function PluginsTab({
  hideToolbar = false,
  view = 'installed',
  installRequest = 0,
}: {
  /** The page supplies its own Install button (and a Marketplace tab). */
  hideToolbar?: boolean
  /** Installed plugins, or the marketplace as a grid of cards. */
  view?: 'installed' | 'marketplace'
  /** Bumped by the page's Install button to open the install panel. */
  installRequest?: number
} = {}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()

  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sources, setSources] = useState<PluginSources | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [details, setDetails] = useState<PluginDetails | null>(null)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

  const [mode, setMode] = useState<'list' | 'browse' | 'install'>('list')
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<MarketEntry[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [installingName, setInstallingName] = useState<string | null>(null)

  // Install-by-source form: local folder / git URL / marketplace name.
  // Works regardless of whether a global marketplace is configured (only
  // the "marketplace" kind depends on one).
  const [installKind, setInstallKind] = useState<PluginSourceKind>('local')
  const [localPath, setLocalPath] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [marketName, setMarketName] = useState('')
  const [installFieldError, setInstallFieldError] = useState<string | null>(null)
  const [installBusy, setInstallBusy] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  const [confirmRemove, setConfirmRemove] = useState<PluginDetails | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const tRef = useRef(t)
  tRef.current = t

  // Where each plugin is on, for the "Enabled on" chips. Best effort: the
  // cards render without it.
  const [matrix, setMatrix] = useState<ExtensionsMatrix | null>(null)
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const refreshMatrix = useCallback(() => {
    Promise.all([getMatrix(), listProjects()])
      .then(([m, list]) => {
        setMatrix(m)
        setProjects(list)
      })
      .catch(() => {})
  }, [])
  useEffect(() => refreshMatrix(), [refreshMatrix])

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const list = await listPlugins('', 'global')
      setPlugins(list)
      return list
    } catch (e) {
      setLoadError(pluginErrorText(tRef.current, e))
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    getPluginSources('', 'global')
      .then(setSources)
      .catch(() => setSources(null))
  }, [refresh])

  const loadDetails = useCallback(
    async (id: string) => {
      setDetails(null)
      setDetailsError(null)
      try {
        setDetails(await getPluginDetails('', id, 'global'))
      } catch (e) {
        setDetailsError(pluginErrorText(tRef.current, e))
        if (toPluginError(e).code === 'not_installed') void refresh()
      }
    },
    [refresh]
  )

  const select = (id: string) => {
    setMode('list')
    setSelectedId(id)
    setToggleError(null)
    setRemoveError(null)
    void loadDetails(id)
  }

  const toggle = async (plugin: InstalledPlugin, enabled: boolean) => {
    const apply = (value: boolean) => {
      setPlugins((list) =>
        list.map((p) => (p.id === plugin.id ? { ...p, enabled: value } : p))
      )
      setDetails((d) => (d && d.id === plugin.id ? { ...d, enabled: value } : d))
    }
    setToggleError(null)
    setToggling(plugin.id)
    apply(enabled)
    try {
      const state = await setPluginEnabled('', plugin.id, enabled, 'global')
      apply(state.enabled)
      invalidateSkills()
      toast.success(
        t(state.enabled ? 'plugins:toggle.enabled' : 'plugins:toggle.disabled', {
          name: plugin.name,
        })
      )
    } catch (e) {
      apply(!enabled)
      setToggleError(
        t('plugins:toggle.failed', { name: plugin.name, error: pluginErrorText(t, e) })
      )
      if (toPluginError(e).code === 'not_installed') void refresh()
    } finally {
      setToggling(null)
    }
  }

  const confirmRemoval = async () => {
    if (!confirmRemove) return
    const target = confirmRemove
    setRemoving(true)
    setRemoveError(null)
    try {
      const report = await removePlugin('', target.id, 'global')
      toast.success(t('plugins:remove.done', { name: report.name, path: report.removedPath }))
      setConfirmRemove(null)
      setSelectedId(null)
      setDetails(null)
      await refresh()
    } catch (e) {
      setRemoveError(t('plugins:remove.failed', { name: target.name, error: pluginErrorText(t, e) }))
      setConfirmRemove(null)
      void refresh()
    } finally {
      invalidateSkills()
      setRemoving(false)
    }
  }

  const openBrowse = () => {
    setMode('browse')
    setSelectedId(null)
    setDetails(null)
    setSearchError(null)
    if (sources?.marketplace) void runSearch()
  }

  const runSearch = async () => {
    setSearching(true)
    setSearchError(null)
    try {
      const results = await searchPlugins(query, 'global')
      setEntries(results)
    } catch (e) {
      setSearchError(pluginErrorText(t, e))
    } finally {
      setSearching(false)
    }
  }

  const installFromMarket = async (entry: MarketEntry) => {
    setInstallingName(entry.name)
    try {
      const operationId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `install-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const plugin = await installPlugin(
        '',
        { kind: 'marketplace', name: entry.name },
        operationId,
        'global'
      )
      invalidateSkills()
      toast.success(t('plugins:install.done', { name: plugin.name }))
      await refresh()
      select(plugin.id)
    } catch (e) {
      toast.error(t('plugins:install.failed', { error: pluginErrorText(t, e) }))
    } finally {
      setInstallingName(null)
    }
  }

  // The page's Install button.
  const lastInstallRequest = useRef(installRequest)
  useEffect(() => {
    if (installRequest !== lastInstallRequest.current) {
      lastInstallRequest.current = installRequest
      openInstall()
    }
     
  }, [installRequest])

  // The Marketplace tab lists the index straight away.
  useEffect(() => {
    if (view === 'marketplace' && sources?.marketplace) void runSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, sources?.marketplace])

  const surfaceColumns = [
    { key: 'home', label: t('common:extensionsManager.surfaces.home', undefined) ?? 'Home' },
    { key: 'rooms', label: t('common:extensionsManager.surfaces.rooms', undefined) ?? 'Rooms' },
    ...projects.map((p) => ({ key: `cowork:${p.id}`, label: p.name || p.folder })),
  ]
  const enabledOn = (p: InstalledPlugin) => {
    const entry = matrix?.plugins[p.id]
    return (key: string) => p.enabled && (!entry || entry.surfaces.includes(key))
  }

  const sourceLabel = (p: InstalledPlugin) =>
    p.sourceKind ? t(`plugins:source.${p.sourceKind}`) : t('plugins:source.unknown')

  const openInstall = () => {
    setMode('install')
    setSelectedId(null)
    setDetails(null)
    setInstallFieldError(null)
    setInstallError(null)
  }

  const chooseFolder = async () => {
    const picked = await serviceHub.dialog().open({ directory: true })
    const path = Array.isArray(picked) ? picked[0] : picked
    if (path) {
      setLocalPath(path)
      setInstallFieldError(null)
    }
  }

  const gitCheck = checkGitUrl(gitUrl)
  const gitHost = gitCheck.ok ? gitCheck.host : null

  const buildInstallSource = (): InstallSource | null => {
    if (installKind === 'local') {
      if (!localPath.trim()) {
        setInstallFieldError(t('plugins:install.errors.pathRequired'))
        return null
      }
      return { kind: 'local', path: localPath.trim() }
    }
    if (installKind === 'git') {
      if (!gitCheck.ok) {
        setInstallFieldError(
          t(
            gitCheck.reason === 'empty'
              ? 'plugins:install.errors.urlRequired'
              : 'plugins:install.errors.urlFormat'
          )
        )
        return null
      }
      return { kind: 'git', url: gitUrl.trim() }
    }
    if (!marketName.trim()) {
      setInstallFieldError(t('plugins:install.errors.nameRequired'))
      return null
    }
    return { kind: 'marketplace', name: marketName.trim() }
  }

  const submitInstall = async () => {
    if (installBusy) return
    setInstallFieldError(null)
    setInstallError(null)
    const source = buildInstallSource()
    if (!source) return
    const operationId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `install-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setInstallBusy(true)
    try {
      const plugin = await installPlugin('', source, operationId, 'global')
      invalidateSkills()
      toast.success(t('plugins:install.done', { name: plugin.name }))
      await refresh()
      select(plugin.id)
    } catch (e) {
      setInstallError(t('plugins:install.failed', { error: pluginErrorText(t, e) }))
    } finally {
      setInstallBusy(false)
    }
  }

  const renderToolbar = () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        data-testid="plugins-install-button"
        aria-pressed={mode === 'install'}
        onClick={openInstall}
      >
        <Plus aria-hidden />
        {t('plugins:installButton')}
      </Button>
      <Button
        variant="outline"
        size="sm"
        data-testid="plugins-browse-button"
        aria-pressed={mode === 'browse'}
        className={cn(mode === 'browse' && 'border-border-strong bg-hover-btn')}
        onClick={openBrowse}
      >
        <Search aria-hidden />
        {t('plugins:browseButton', undefined)}
      </Button>
      {loadError && (
        <div
          role="alert"
          className="flex w-full items-center gap-2 text-xs break-words text-destructive"
        >
          <OctagonAlert className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{loadError}</span>
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => void refresh()}
          >
            {t('plugins:retry')}
          </Button>
        </div>
      )}
    </div>
  )

  /** One installed plugin as a card: cover, icon tile, what it adds, where it came from. */
  const renderCard = (p: InstalledPlugin, i: number) => {
    const { from } = extensionIcon(p.name)
    const selected = selectedId === p.id && mode === 'list'
    const counts = [
      p.skills ? t('engine:extensions.skillsCount', { count: p.skills }) : null,
      p.commands
        ? t('engine:extensions.commandsCount', { count: p.commands })
        : null,
      p.agents ? t('engine:extensions.agentsCount', { count: p.agents }) : null,
    ].filter(Boolean)
    return (
      <div role="listitem" key={p.id} className="min-w-0">
        <Frame
          style={{
            animationDelay: `${60 + i * 60}ms`,
            ['--g1' as string]: from,
          }}
          className={cn(
            'group h-full motion-safe:animate-rise-in',
            selected &&
              'shadow-[inset_0_0_0_0.8px_var(--border),0_0_0_1.5px_var(--primary)]'
          )}
        >
          <div
            className={cn(
              'relative flex h-[74px] items-start justify-end rounded-t-[9px] border-b-[0.8px] border-border p-2.5',
              'bg-[radial-gradient(circle_at_18%_130%,color-mix(in_oklab,var(--g1)_70%,transparent),transparent_62%),linear-gradient(120deg,color-mix(in_oklab,var(--g1)_38%,transparent),transparent),repeating-linear-gradient(-62deg,transparent_0_10px,rgba(127,127,127,.08)_10px_10.8px)]'
            )}
          >
            <Switch
              className="relative z-20"
              checked={p.enabled}
              disabled={toggling === p.id}
              aria-label={t('plugins:toggle.label', { name: p.name })}
              onCheckedChange={(checked) => void toggle(p, checked)}
            />
            <ExtensionIcon
              name={p.name}
              size={40}
              className={cn(
                'absolute bottom-[-16px] left-3.5 z-10 shadow-[0_0_0_2.5px_var(--card),0_8px_18px_-8px_color-mix(in_oklab,var(--g1)_70%,transparent)] transition-transform duration-300 ease-expo group-hover:-translate-y-0.5 group-hover:-rotate-4',
                !p.enabled && 'grayscale-[.9]'
              )}
            />
          </div>
          <div className="relative flex flex-1 flex-col gap-2.5 rounded-b-[9px] bg-card p-3.5 pt-6">
            <button
              type="button"
              aria-current={selected ? 'true' : undefined}
              className="flex min-w-0 items-center gap-2 text-left outline-none after:absolute after:inset-0 after:rounded-b-[9px] after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/40"
              onClick={() => select(p.id)}
            >
              <b className="truncate text-sm font-semibold text-foreground">
                {p.name}
              </b>
              <Chip mono className="h-5">
                {t('plugins:version', { version: p.version })}
              </Chip>
            </button>
            <p className="m-0 line-clamp-2 text-[12.5px] leading-normal text-muted-foreground">
              {p.description || t('plugins:details.noDescription')}
            </p>
            {counts.length > 0 && (
              <span>
                <Chip>
                  <Sparkles aria-hidden />
                  {counts.join(' · ')}
                </Chip>
              </span>
            )}
            {matrix && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="mr-1 text-[11px] font-medium text-subtle-foreground uppercase">
                  {t('common:extensionsManager.enablement.title', undefined) ?? 'Enabled on'}
                </span>
                {surfaceColumns.slice(0, 4).map((c) => {
                  const on = enabledOn(p)(c.key)
                  return (
                    <span
                      key={c.key}
                      className={cn(
                        'rounded-full border-[0.8px] px-2 py-0.5 text-[11px] transition-colors',
                        on
                          ? 'border-transparent bg-[color-mix(in_oklab,var(--success)_14%,transparent)] text-success'
                          : 'border-dashed border-border-strong text-subtle-foreground'
                      )}
                    >
                      {c.label}
                    </span>
                  )
                })}
                {surfaceColumns.length > 4 && (
                  <span className="text-[11px] text-subtle-foreground">
                    +{surfaceColumns.length - 4}
                  </span>
                )}
              </div>
            )}
            <div className="relative z-10 mt-auto flex items-center justify-between gap-2 text-xs text-subtle-foreground">
              <span
                className="min-w-0 truncate font-mono"
                title={p.source ?? undefined}
              >
                {/* A repository reads best as its address; a folder or a
                    marketplace name by what kind of source it is (the full
                    path is in the tooltip and the details). */}
                {p.sourceKind === 'git' && p.source
                  ? p.source.replace(/^https?:\/\//, '')
                  : sourceLabel(p)}
              </span>
              <RowMenu
                label={t('engine:extensions.pluginActions', { name: p.name })}
                items={[
                  {
                    label: t('engine:extensions.details'),
                    icon: <Info />,
                    onSelect: () => select(p.id),
                  },
                  {
                    label: p.enabled
                      ? t('engine:extensions.disable')
                      : t('engine:extensions.enable'),
                    icon: <Power />,
                    disabled: toggling === p.id,
                    onSelect: () => void toggle(p, !p.enabled),
                  },
                  'separator',
                  {
                    label: t('plugins:remove.button'),
                    icon: <Trash2 />,
                    destructive: true,
                    onSelect: () => {
                      setRemoveError(null)
                      void getPluginDetails('', p.id, 'global')
                        .then(setConfirmRemove)
                        .catch((e) =>
                          setRemoveError(
                            t('plugins:remove.failed', {
                              name: p.name,
                              error: pluginErrorText(t, e),
                            })
                          )
                        )
                    },
                  },
                ]}
              />
            </div>
          </div>
        </Frame>
      </div>
    )
  }

  /** A marketplace entry as a card, with its Install button. */
  const renderMarketCard = (entry: MarketEntry, i: number) => {
    const { from } = extensionIcon(entry.name)
    const installed = plugins.some((p) => p.name === entry.name)
    return (
      <div role="listitem" key={entry.name} className="min-w-0">
        <Frame
          style={{ animationDelay: `${60 + i * 60}ms`, ['--g1' as string]: from }}
          className="group h-full motion-safe:animate-rise-in motion-safe:hover:-translate-y-0.5"
        >
          <div className="relative flex h-[74px] items-start justify-end rounded-t-[9px] border-b-[0.8px] border-border bg-[radial-gradient(circle_at_18%_130%,color-mix(in_oklab,var(--g1)_70%,transparent),transparent_62%),linear-gradient(120deg,color-mix(in_oklab,var(--g1)_38%,transparent),transparent),repeating-linear-gradient(-62deg,transparent_0_10px,rgba(127,127,127,.08)_10px_10.8px)] p-2.5">
            <ExtensionIcon
              name={entry.name}
              size={40}
              className="absolute bottom-[-16px] left-3.5 z-10 shadow-[0_0_0_2.5px_var(--card),0_8px_18px_-8px_color-mix(in_oklab,var(--g1)_70%,transparent)] transition-transform duration-300 ease-expo group-hover:-translate-y-0.5 group-hover:-rotate-4"
            />
          </div>
          <div className="relative flex flex-1 flex-col gap-2.5 rounded-b-[9px] bg-card p-3.5 pt-6">
            <b className="truncate text-sm font-semibold text-foreground">{entry.name}</b>
            <p className="m-0 line-clamp-2 text-[12.5px] leading-normal text-muted-foreground">
              {entry.description}
            </p>
            <div className="mt-auto flex items-center justify-between gap-2 text-xs text-subtle-foreground">
              <span className="min-w-0 truncate font-mono" title={entry.repo}>
                {urlHost(entry.repo) || entry.repo}
              </span>
              <Button
                size="sm"
                className="h-7 shrink-0 pointer-coarse:h-11"
                disabled={installed || installingName === entry.name}
                onClick={() => void installFromMarket(entry)}
              >
                {installingName === entry.name && (
                  <Loader2 className="motion-safe:animate-spin" size={14} aria-hidden />
                )}
                {installed ? t('plugins:state.installed') : t('plugins:installButton')}
              </Button>
            </div>
          </div>
        </Frame>
      </div>
    )
  }

  const renderMarketGrid = () => (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-4"
      role="list"
      aria-label={t('plugins:browseButton')}
      aria-busy={searching}
    >
      {!sources?.marketplace ? (
        <div className="col-span-full" data-testid="plugins-browse-unconfigured">
          <EmptyState
            icon={<Icon name="x-puzzle" size={20} />}
            title={t('plugins:browse.notConfigured')}
            description={t('plugins:browse.notConfiguredHint')}
          />
        </div>
      ) : searchError ? (
        <p role="alert" className={cn(ALERT, 'col-span-full')}>
          <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{searchError}</span>
        </p>
      ) : searching && entries.length === 0 ? (
        <p className="col-span-full py-8 text-center text-xs text-muted-foreground">
          {t('plugins:loading')}
        </p>
      ) : (
        entries.map(renderMarketCard)
      )}
    </div>
  )

  const renderGrid = () => (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-4"
      role="list"
      aria-label={t('plugins:listLabel')}
      aria-busy={loading}
    >
      {loading && plugins.length === 0 ? (
        <p className="col-span-full py-8 text-center text-xs text-muted-foreground">
          {t('plugins:loading')}
        </p>
      ) : plugins.length === 0 ? (
        <div className="col-span-full">
          <EmptyState
            icon={<Icon name="x-puzzle" size={20} />}
            title={t('plugins:empty.title')}
            description={t('plugins:empty.body')}
          />
        </div>
      ) : (
        plugins.map(renderCard)
      )}
    </div>
  )

  const renderDetails = () => {
    const plugin = plugins.find((p) => p.id === selectedId)
    if (!plugin) {
      return (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          {t('plugins:pickOne')}
        </div>
      )
    }
    const switchId = `plugin-enabled-${plugin.id}`
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground break-words">
              {plugin.name}{' '}
              <span className="text-xs text-muted-foreground">
                {t('plugins:version', { version: plugin.version })}
              </span>
            </div>
            <p className="text-xs text-muted-foreground break-words">
              {plugin.description || t('plugins:details.noDescription')}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Label htmlFor={switchId} className="text-xs">
              {plugin.enabled ? t('plugins:state.enabled') : t('plugins:state.disabled')}
            </Label>
            <Switch
              id={switchId}
              checked={plugin.enabled}
              disabled={toggling === plugin.id}
              aria-label={t('plugins:toggle.label', { name: plugin.name })}
              onCheckedChange={(checked) => void toggle(plugin, checked)}
            />
          </div>
        </div>
        {toggleError && (
          <p role="alert" className={ALERT}>
            <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{toggleError}</span>
          </p>
        )}
        {removeError && (
          <p role="alert" className={ALERT}>
            <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{removeError}</span>
          </p>
        )}
        {detailsError ? (
          <p role="alert" className={ALERT}>
            <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{t('plugins:details.failed', { error: detailsError })}</span>
          </p>
        ) : !details || details.id !== plugin.id ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="motion-safe:animate-spin" size={12} aria-hidden />
            {t('plugins:details.loading')}
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1.5 text-xs [&_dd]:font-mono [&_dd]:text-fg-2">
              <dt className="text-muted-foreground">{t('plugins:source.label')}</dt>
              <dd className="break-all">
                {sourceLabel(details)}
                {details.source ? `: ${details.source}` : ''}
              </dd>
              <dt className="text-muted-foreground">{t('plugins:details.installedPath')}</dt>
              <dd className="break-all">{details.installedPath}</dd>
            </dl>
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase text-subtle-foreground">
                {t('common:extensionsManager.enablement.title', undefined) ?? 'Enabled on'}
              </div>
              <EnablementGrid kind="plugin" id={plugin.id} />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t('common:extensionsManager.enablement.pluginNote', undefined) ??
                  "Governs this plugin's skills and subagents on each surface. Its slash commands are not yet filtered by this toggle."}
              </p>
            </div>
            <div>
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  setRemoveError(null)
                  setConfirmRemove(details)
                }}
              >
                <Trash2 size={14} aria-hidden />
                {t('plugins:remove.button')}
              </Button>
            </div>
          </>
        )}
      </div>
    )
  }

  const renderBrowse = () => (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {!sources?.marketplace ? (
        <div
          data-testid="plugins-browse-unconfigured"
          className="flex flex-col gap-1 rounded-xl border border-dashed border-border-strong px-3 py-4 text-xs text-muted-foreground"
        >
          <p>{t('plugins:browse.notConfigured')}</p>
          <p>{t('plugins:browse.notConfiguredHint')}</p>
        </div>
      ) : (
        <>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void runSearch()
            }}
          >
            <Input
              value={query}
              placeholder={t('plugins:install.marketplaceNameLabel')}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="plugins-browse-query"
            />
            <Button type="submit" size="sm" disabled={searching}>
              {searching ? (
                <Loader2 className="motion-safe:animate-spin" size={14} aria-hidden />
              ) : (
                <Search size={14} aria-hidden />
              )}
            </Button>
          </form>
          {searchError && (
            <p role="alert" className={ALERT}>
              <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0">{searchError}</span>
            </p>
          )}
          <div className="flex flex-col gap-1" role="list" aria-label={t('plugins:browseButton')}>
            {entries.map((entry) => (
              <div
                key={entry.name}
                role="listitem"
                className="flex items-start justify-between gap-2 rounded-lg border-[0.8px] border-border bg-card px-2.5 py-2 transition-colors hover:bg-hover-row"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{entry.name}</div>
                  <div className="text-xs text-muted-foreground break-words">
                    {entry.description}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 gap-1.5"
                  disabled={installingName === entry.name}
                  onClick={() => void installFromMarket(entry)}
                >
                  {installingName === entry.name ? (
                    <Loader2 className="motion-safe:animate-spin" size={14} aria-hidden />
                  ) : (
                    <Plus size={14} aria-hidden />
                  )}
                  {t('plugins:installButton')}
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )

  const gitDisabled = sources !== null && !sources.gitAvailable

  const renderInstall = () => (
    <form
      className="flex min-h-0 flex-1 flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submitInstall()
      }}
    >
      <fieldset className="flex flex-col gap-2" disabled={installBusy}>
        <legend className="text-xs text-muted-foreground mb-1">
          {t('plugins:install.sourceLabel')}
        </legend>
        <RadioGroup
          value={installKind}
          onValueChange={(v) => {
            setInstallKind(v as PluginSourceKind)
            setInstallFieldError(null)
          }}
          className="gap-2"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem id="global-plugin-source-local" value="local" />
            <Label htmlFor="global-plugin-source-local">{t('plugins:install.local')}</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem
              id="global-plugin-source-git"
              value="git"
              disabled={gitDisabled}
            />
            <Label htmlFor="global-plugin-source-git">{t('plugins:install.git')}</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="global-plugin-source-marketplace" value="marketplace" />
            <Label htmlFor="global-plugin-source-marketplace">
              {t('plugins:install.marketplace')}
            </Label>
          </div>
        </RadioGroup>
      </fieldset>

      {installKind === 'local' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="global-plugin-local-path">{t('plugins:install.localPathLabel')}</Label>
          <div className="flex gap-2">
            <Input
              id="global-plugin-local-path"
              value={localPath}
              disabled={installBusy}
              placeholder={t('plugins:install.localPathPlaceholder')}
              onChange={(e) => {
                setLocalPath(e.target.value)
                setInstallFieldError(null)
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 shrink-0"
              disabled={installBusy}
              onClick={() => void chooseFolder()}
            >
              <FolderOpen size={14} />
              {t('plugins:install.chooseFolder')}
            </Button>
          </div>
        </div>
      )}

      {installKind === 'git' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="global-plugin-git-url">{t('plugins:install.gitUrlLabel')}</Label>
          <Input
            id="global-plugin-git-url"
            value={gitUrl}
            disabled={installBusy}
            placeholder={t('plugins:install.gitUrlPlaceholder')}
            onChange={(e) => {
              setGitUrl(e.target.value)
              setInstallFieldError(null)
            }}
          />
          <p className="text-xs text-muted-foreground">
            {gitHost
              ? t('plugins:install.gitNotice', { host: gitHost })
              : t('plugins:install.gitNoticeNoHost')}
          </p>
        </div>
      )}

      {installKind === 'marketplace' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="global-plugin-market-name">
            {t('plugins:install.marketplaceNameLabel')}
          </Label>
          <Input
            id="global-plugin-market-name"
            value={marketName}
            disabled={installBusy}
            onChange={(e) => {
              setMarketName(e.target.value)
              setInstallFieldError(null)
            }}
          />
          {sources?.marketplace ? (
            <p className="text-xs text-muted-foreground">
              {t('plugins:install.marketplaceNotice', { host: urlHost(sources.marketplace) })}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('plugins:browse.notConfigured')}
            </p>
          )}
        </div>
      )}

      {installFieldError && (
        <p role="alert" className={ALERT}>
          <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{installFieldError}</span>
        </p>
      )}
      {installError && (
        <p role="alert" className={ALERT}>
          <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{installError}</span>
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setMode('list')}>
          {t('plugins:install.back')}
        </Button>
        <Button type="submit" size="sm" disabled={installBusy}>
          {installBusy && <Loader2 className="motion-safe:animate-spin" size={14} aria-hidden />}
          {t('plugins:install.submit')}
        </Button>
      </div>
    </form>
  )

  const selectedPlugin = plugins.find((p) => p.id === selectedId)
  const panelOpen = mode !== 'list' || !!selectedPlugin
  const panelTitle =
    mode === 'install'
      ? t('plugins:install.title')
      : mode === 'browse'
        ? t('plugins:browseButton')
        : (selectedPlugin?.name ?? '')

  return (
    <>
      <div className="flex min-h-0 flex-col gap-4">
        {!hideToolbar && renderToolbar()}
        {hideToolbar && loadError && (
          <p role="alert" className={ALERT}>
            <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{loadError}</span>
          </p>
        )}
        {removeError && !selectedPlugin && (
          <p role="alert" className={ALERT}>
            <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{removeError}</span>
          </p>
        )}
        <div
          className={cn(
            'grid items-start gap-4',
            panelOpen && 'lg:grid-cols-[minmax(0,1fr)_380px]'
          )}
        >
          {view === 'marketplace' ? renderMarketGrid() : renderGrid()}
          {panelOpen && (
            <Frame className="motion-safe:animate-rise-in">
              <FrameHeader
                icon={
                  mode === 'list' && selectedPlugin ? (
                    <ExtensionIcon
                      name={selectedPlugin.name}
                      size={18}
                      className="rounded-md"
                    />
                  ) : mode === 'browse' ? (
                    <Search />
                  ) : (
                    <Plus />
                  )
                }
                title={panelTitle}
                actions={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('engine:extensions.closePanel')}
                    onClick={() => {
                      setMode('list')
                      setSelectedId(null)
                      setDetails(null)
                    }}
                  >
                    <X aria-hidden />
                  </Button>
                }
              />
              <FrameBody className="gap-3 p-3.5">
                {mode === 'install'
                  ? renderInstall()
                  : mode === 'browse'
                    ? renderBrowse()
                    : renderDetails()}
              </FrameBody>
            </Frame>
          )}
        </div>
      </div>

      {confirmRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 motion-safe:animate-fade-in">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('plugins:remove.title', { name: confirmRemove.name })}
            className="w-full max-w-sm rounded-xl border-[0.8px] border-border bg-card p-4 shadow-pop motion-safe:animate-dlg-in"
          >
            <div className="text-sm font-semibold">
              {t('plugins:remove.title', { name: confirmRemove.name })}
            </div>
            <p className="mt-1 break-all text-xs text-muted-foreground">
              {t('plugins:remove.body', { path: confirmRemove.installedPath })}
            </p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={removing}
                onClick={() => setConfirmRemove(null)}
              >
                {t('plugins:remove.cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={removing}
                onClick={() => void confirmRemoval()}
              >
                {removing && (
                  <Loader2
                    className="motion-safe:animate-spin"
                    size={14}
                    aria-hidden
                  />
                )}
                {t('plugins:remove.confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
