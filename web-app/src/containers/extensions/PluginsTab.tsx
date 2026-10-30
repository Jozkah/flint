import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, OctagonAlert, Plus, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { usePluginInstallForm } from '@/hooks/usePluginInstall'
import { usePluginManager } from '@/hooks/usePluginManager'
import { usePluginMarket } from '@/hooks/usePluginMarket'
import { invalidateSkills } from '@/hooks/useSkills'
import {
  getPluginDetails,
  pluginErrorText,
  type InstalledPlugin,
} from '@/lib/pluginStore'
import {
  getMatrix,
  listProjects,
  type ExtensionsMatrix,
  type ProjectEntry,
} from '@/lib/extensionsStore'
import { Icon } from '@/components/ui/icon'
import { ExtensionIcon } from '@/containers/extensions/ExtensionIcon'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { PluginAlert } from '@/containers/extensions/plugins/PluginAlert'
import { PluginCard } from '@/containers/extensions/plugins/PluginCard'
import { MarketCard } from '@/containers/extensions/plugins/MarketCard'
import { PluginDetailsPane } from '@/containers/extensions/plugins/PluginDetailsPane'
import { PluginBrowsePane } from '@/containers/extensions/plugins/PluginBrowsePane'
import { InstallPluginForm } from '@/containers/extensions/plugins/InstallPluginForm'

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

  const manager = usePluginManager({ scopeFolder: null, global: true })
  const {
    plugins,
    loading,
    loadError,
    sources,
    selectedId,
    setSelectedId,
    details,
    setDetails,
    detailsError,
    toggling,
    toggleError,
    confirmRemove,
    setConfirmRemove,
    removing,
    removeError,
    setRemoveError,
    updating,
    updateError,
    refresh,
    toggle,
    runUpdate,
    confirmRemoval,
  } = manager

  const [mode, setMode] = useState<'list' | 'browse' | 'install'>('list')
  // The install form's field values outlive the panel; see InstallPluginForm.
  const installForm = usePluginInstallForm()
  // Each opening of the install panel starts with a clean busy/error state.
  const [installOpenCount, setInstallOpenCount] = useState(0)

  // Where each plugin is on, for the "Enabled on" chips. Best effort: the
  // cards render without it.
  const [matrix, setMatrix] = useState<ExtensionsMatrix | null>(null)
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const matrixLoadId = useRef(0)
  const refreshMatrix = useCallback(() => {
    const id = ++matrixLoadId.current
    Promise.all([getMatrix(), listProjects()])
      .then(([m, list]) => {
        if (id !== matrixLoadId.current) return
        setMatrix(m)
        setProjects(list)
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    refreshMatrix()
    return () => {
      matrixLoadId.current++
    }
  }, [refreshMatrix])

  const select = (id: string) => {
    setMode('list')
    manager.select(id)
  }

  /** After any install: tell skills, refresh the list and show the plugin. */
  const onInstalled = async (plugin: InstalledPlugin) => {
    invalidateSkills()
    toast.success(t('plugins:install.done', { name: plugin.name }))
    await refresh()
    select(plugin.id)
  }

  const market = usePluginMarket(onInstalled)
  const { entries, searching, searchError, runSearch, installFromMarket, installingName } =
    market

  const openBrowse = () => {
    setMode('browse')
    setSelectedId(null)
    setDetails(null)
    market.setSearchError(null)
    if (sources?.marketplace) void runSearch()
  }

  const openInstall = () => {
    setMode('install')
    setSelectedId(null)
    setDetails(null)
    installForm.setFieldError(null)
    setInstallOpenCount((n) => n + 1)
  }

  // The page's Install button.
  const lastInstallRequest = useRef(installRequest)
  useEffect(() => {
    if (installRequest !== lastInstallRequest.current) {
      lastInstallRequest.current = installRequest
      openInstall()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const askRemove = (p: InstalledPlugin) => {
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
  }

  const toolbar = (
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

  const marketGrid = (
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
        <PluginAlert className="col-span-full">{searchError}</PluginAlert>
      ) : searching && entries.length === 0 ? (
        <p className="col-span-full py-8 text-center text-xs text-muted-foreground">
          {t('plugins:loading')}
        </p>
      ) : (
        entries.map((entry, i) => (
          <MarketCard
            key={`${entry.name}-${i}`}
            entry={entry}
            index={i}
            installed={plugins.some((p) => p.name === entry.name)}
            installing={installingName === entry.name}
            onInstall={() => void installFromMarket(entry)}
          />
        ))
      )}
    </div>
  )

  const installedGrid = (
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
        plugins.map((p, i) => (
          <PluginCard
            key={p.id}
            plugin={p}
            index={i}
            selected={selectedId === p.id && mode === 'list'}
            toggling={toggling === p.id}
            surfaces={matrix ? surfaceColumns : null}
            isOnSurface={enabledOn(p)}
            sourceLabel={sourceLabel(p)}
            onSelect={() => select(p.id)}
            onToggle={(checked) => void toggle(p, checked)}
            onRemove={() => askRemove(p)}
          />
        ))
      )}
    </div>
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
        {!hideToolbar && toolbar}
        {hideToolbar && loadError && <PluginAlert>{loadError}</PluginAlert>}
        {removeError && !selectedPlugin && <PluginAlert>{removeError}</PluginAlert>}
        <div
          className={cn(
            'grid items-start gap-4',
            panelOpen && 'lg:grid-cols-[minmax(0,1fr)_380px]'
          )}
        >
          {view === 'marketplace' ? marketGrid : installedGrid}
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
                {mode === 'install' ? (
                  <InstallPluginForm
                    key={installOpenCount}
                    form={installForm}
                    sources={sources}
                    onInstalled={onInstalled}
                    onBack={() => setMode('list')}
                  />
                ) : mode === 'browse' ? (
                  <PluginBrowsePane
                    configured={!!sources?.marketplace}
                    query={market.query}
                    onQueryChange={market.setQuery}
                    onSearch={() => void runSearch()}
                    searching={searching}
                    searchError={searchError}
                    entries={entries}
                    installingName={installingName}
                    onInstall={(entry) => void installFromMarket(entry)}
                  />
                ) : (
                  <PluginDetailsPane
                    plugin={selectedPlugin}
                    details={details}
                    detailsError={detailsError}
                    toggling={!!selectedPlugin && toggling === selectedPlugin.id}
                    toggleError={toggleError}
                    removeError={removeError}
                    updateError={updateError}
                    updating={updating}
                    sourceLabel={sourceLabel}
                    onToggle={(checked) =>
                      selectedPlugin && void toggle(selectedPlugin, checked)
                    }
                    onUpdate={(d) => void runUpdate(d)}
                    onRemove={(d) => {
                      setRemoveError(null)
                      setConfirmRemove(d)
                    }}
                  />
                )}
              </FrameBody>
            </Frame>
          )}
        </div>
      </div>

      <Dialog
        open={confirmRemove !== null}
        onOpenChange={(open) => {
          if (!open && !removing) setConfirmRemove(null)
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t('plugins:remove.title', { name: confirmRemove?.name ?? '' })}
            </DialogTitle>
            <DialogDescription className="break-all">
              {t('plugins:remove.body', {
                path: confirmRemove?.installedPath ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
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
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
