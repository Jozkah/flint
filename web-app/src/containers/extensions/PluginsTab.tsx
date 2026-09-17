import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, OctagonAlert, Plus, Puzzle, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { invalidateSkills } from '@/hooks/useSkills'
import {
  getPluginDetails,
  getPluginSources,
  installPlugin,
  listPlugins,
  pluginErrorText,
  removePlugin,
  searchPlugins,
  setPluginEnabled,
  toPluginError,
  type InstalledPlugin,
  type MarketEntry,
  type PluginDetails,
  type PluginSources,
} from '@/lib/pluginStore'

const ALERT = 'flex items-start gap-1.5 text-xs text-destructive break-words'

/**
 * Manage plugins installed in the user's global plugin store (shared by
 * every workspace, not one project's folder), plus a marketplace browse
 * panel to discover and install new ones. Lifts the list/details/install/
 * remove flow out of `PluginsManagerDialog` for `scope: 'global'`.
 */
export default function PluginsTab() {
  const { t } = useTranslation()

  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sources, setSources] = useState<PluginSources | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [details, setDetails] = useState<PluginDetails | null>(null)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

  const [mode, setMode] = useState<'list' | 'browse'>('list')
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<MarketEntry[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [installingName, setInstallingName] = useState<string | null>(null)

  const [confirmRemove, setConfirmRemove] = useState<PluginDetails | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const tRef = useRef(t)
  tRef.current = t

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
    void runSearch()
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

  const sourceLabel = (p: InstalledPlugin) =>
    p.sourceKind ? t(`plugins:source.${p.sourceKind}`) : t('plugins:source.unknown')

  const renderList = () => (
    <div className="flex max-h-[40vh] min-h-0 flex-col gap-2 border-b border-border pb-3 sm:max-h-none sm:w-1/3 sm:border-r sm:border-b-0 sm:pr-3 sm:pb-0">
      <Button
        variant="outline"
        size="sm"
        data-testid="plugins-browse-button"
        aria-pressed={mode === 'browse'}
        className={cn('gap-1.5 justify-start', mode === 'browse' && 'bg-accent text-foreground')}
        onClick={openBrowse}
      >
        <Search size={14} aria-hidden />
        {t('plugins:browseButton', undefined)}
      </Button>
      {loadError && (
        <div role="alert" className="text-xs text-destructive break-words">
          <p className="flex items-start gap-1.5">
            <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{loadError}</span>
          </p>
          <Button variant="link" size="sm" className="px-0" onClick={() => void refresh()}>
            {t('plugins:retry')}
          </Button>
        </div>
      )}
      <div
        className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1"
        role="list"
        aria-label={t('plugins:listLabel')}
        aria-busy={loading}
      >
        {loading && plugins.length === 0 ? (
          <p className="text-xs text-muted-foreground px-1 py-2">{t('plugins:loading')}</p>
        ) : plugins.length === 0 ? (
          <p className="text-xs text-muted-foreground px-1 py-2">{t('plugins:empty.title')}</p>
        ) : (
          plugins.map((p) => (
            <div role="listitem" key={p.id}>
              <button
                type="button"
                aria-current={selectedId === p.id ? 'true' : undefined}
                className={cn(
                  'relative w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 text-sm text-ink-2 hover:bg-sunken hover:text-foreground outline-none',
                  selectedId === p.id &&
                    mode === 'list' &&
                    'bg-accent text-foreground'
                )}
                onClick={() => select(p.id)}
              >
                <Puzzle size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex-1 min-w-0">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate font-medium text-foreground">{p.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t('plugins:version', { version: p.version })}
                    </span>
                  </span>
                  {p.description && (
                    <span className="block line-clamp-2 break-words text-xs text-muted-foreground">
                      {p.description}
                    </span>
                  )}
                  <span className="block truncate text-xs text-muted-foreground">
                    {sourceLabel(p)}
                    {p.source ? `: ${p.source}` : ''}
                  </span>
                </span>
              </button>
            </div>
          ))
        )}
      </div>
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
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pr-1">
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
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">{t('plugins:source.label')}</dt>
              <dd className="break-all">
                {sourceLabel(details)}
                {details.source ? `: ${details.source}` : ''}
              </dd>
              <dt className="text-muted-foreground">{t('plugins:details.installedPath')}</dt>
              <dd className="break-all">{details.installedPath}</dd>
            </dl>
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
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pr-1">
      <div className="text-sm font-medium">{t('plugins:browseButton')}</div>
      {!sources?.marketplace ? (
        <p className="text-xs text-muted-foreground">{t('plugins:install.gitUnavailable')}</p>
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
                className="flex items-start justify-between gap-2 rounded-md border border-border px-2 py-1.5"
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

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 sm:h-full sm:flex-row sm:gap-4 sm:overflow-hidden">
        {renderList()}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2">
          {mode === 'browse' ? renderBrowse() : renderDetails()}
        </div>
      </div>

      {confirmRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-lg">
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
                {removing && <Loader2 className="motion-safe:animate-spin" size={14} aria-hidden />}
                {t('plugins:remove.confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
