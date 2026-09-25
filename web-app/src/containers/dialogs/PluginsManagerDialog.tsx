import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Check,
  Eye,
  EyeOff,
  FolderOpen,
  Globe,
  Loader2,
  OctagonAlert,
  Plus,
  Puzzle,
  Trash2,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useGlobalExtensions, type Scope } from '@/hooks/useGlobalExtensions'
import { useServiceHub } from '@/hooks/useServiceHub'
import { invalidateSkills } from '@/hooks/useSkills'
import {
  cancelPluginInstall,
  checkGitUrl,
  getPluginDetails,
  getPluginSources,
  installPlugin,
  listPlugins,
  pluginErrorText,
  removePlugin,
  setPluginEnabled,
  toPluginError,
  urlHost,
  type InstallSource,
  type InstalledPlugin,
  type PluginDetails,
  type PluginSourceKind,
  type PluginSources,
} from '@/lib/pluginStore'

type InstallState = {
  id: string
  kind: PluginSourceKind
  host: string | null
  cancelling: boolean
}

/** An inline error: always an icon and words, next to what failed. */
const ALERT = 'flex items-start gap-1.5 text-xs text-destructive break-words'

const newOperationId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `install-${Date.now()}-${Math.random().toString(36).slice(2)}`

function PluginListRow({
  plugin: p,
  isSelected,
  sourceLabel: srcLabel,
  toggling,
  scope,
  onSelect,
  onToggle,
  onScopeChange,
  onRequestRemove,
  t,
}: {
  plugin: InstalledPlugin
  isSelected: boolean
  sourceLabel: string
  toggling: boolean
  scope: Scope
  onSelect: () => void
  onToggle: (enabled: boolean) => void
  onScopeChange: (scope: Scope) => void
  onRequestRemove: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  const openRowMenu = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuOpen(true)
  }

  const onRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      openRowMenu(e)
    }
  }

  return (
    <div role="listitem" onContextMenu={openRowMenu} onKeyDown={onRowKeyDown}>
      <button
        type="button"
        aria-current={isSelected ? 'true' : undefined}
        className={cn(
          'relative w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 text-sm text-fg-2 hover:bg-muted hover:text-foreground outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring',
          isSelected &&
            'bg-accent text-foreground before:absolute before:left-0 before:inset-y-2 before:w-0.5 before:rounded-full before:bg-acc'
        )}
        onClick={onSelect}
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
          <span className="block text-xs text-muted-foreground">
            {p.enabled ? t('plugins:state.enabled') : t('plugins:state.disabled')}
            {' · '}
            {scope === 'global' ? 'Global' : 'Workspace'}
            {' · '}
            {t('plugins:counts', {
              skills: p.skills,
              commands: p.commands,
              agents: p.agents,
            })}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {srcLabel}
            {p.source ? `: ${p.source}` : ''}
          </span>
        </span>
      </button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger className="sr-only" />
        <DropdownMenuContent className="w-52" align="start">
          <DropdownMenuItem
            disabled={toggling}
            onSelect={() => onToggle(!p.enabled)}
          >
            {p.enabled ? <EyeOff size={14} /> : <Eye size={14} />}
            <span>{p.enabled ? t('plugins:toggle.disable') : t('plugins:toggle.enable')}</span>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Globe size={14} />
              <span>Scope</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => onScopeChange('workspace')}>
                {scope === 'workspace' && <Check size={14} />}
                <span>Workspace only</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onScopeChange('global')}>
                {scope === 'global' && <Check size={14} />}
                <span>Global (all workspaces)</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={onRequestRemove}
          >
            <Trash2 size={14} />
            <span>{t('plugins:remove.button')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * Manage the plugins installed in the current Cowork session's project folder:
 * list, inspect, install (local folder, git URL, or a configured marketplace),
 * enable/disable, and remove. Every result shown here is what the backend
 * reported; nothing is announced before the command settles.
 */
export default function PluginsManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const sessions = useCoworkSessions((s) => s.sessions)
  const currentId = useCoworkSessions((s) => s.currentId)
  const folder = sessions.find((s) => s.id === currentId)?.folder ?? null

  const globalExt = useGlobalExtensions()

  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sources, setSources] = useState<PluginSources | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [details, setDetails] = useState<PluginDetails | null>(null)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

  const [mode, setMode] = useState<'browse' | 'install'>('browse')
  const [kind, setKind] = useState<PluginSourceKind>('local')
  const [localPath, setLocalPath] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [marketName, setMarketName] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<InstallState | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installNotice, setInstallNotice] = useState<string | null>(null)
  const installingRef = useRef<InstallState | null>(null)

  const [confirmRemove, setConfirmRemove] = useState<PluginDetails | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const fieldErrorId = useId()
  const noticeId = useId()

  // Loaders read `t` through a ref so an unstable `t` identity cannot
  // re-trigger the load effect on every render.
  const tRef = useRef(t)
  tRef.current = t

  const refresh = useCallback(async () => {
    if (!folder) {
      setPlugins([])
      return []
    }
    setLoading(true)
    setLoadError(null)
    try {
      const list = await listPlugins(folder)
      setPlugins(list)
      return list
    } catch (e) {
      setLoadError(pluginErrorText(tRef.current, e))
      return null
    } finally {
      setLoading(false)
    }
  }, [folder])

  useEffect(() => {
    if (!open || !folder) return
    void refresh()
    getPluginSources(folder)
      .then(setSources)
      // Unknown sources are not an error worth blocking on: the install
      // itself reports a missing git or marketplace precisely.
      .catch(() => setSources(null))
  }, [open, folder, refresh])

  // Reset per-folder state when the project changes.
  useEffect(() => {
    setSelectedId(null)
    setDetails(null)
    setMode('browse')
  }, [folder])

  const loadDetails = useCallback(
    async (id: string): Promise<PluginDetails | null> => {
      if (!folder) return null
      setDetails(null)
      setDetailsError(null)
      try {
        const d = await getPluginDetails(folder, id)
        setDetails(d)
        return d
      } catch (e) {
        setDetailsError(pluginErrorText(tRef.current, e))
        if (toPluginError(e).code === 'not_installed') void refresh()
        return null
      }
    },
    [folder, refresh]
  )

  const select = (id: string) => {
    setMode('browse')
    setSelectedId(id)
    setToggleError(null)
    setRemoveError(null)
    void loadDetails(id)
  }

  const toggle = async (plugin: InstalledPlugin, enabled: boolean) => {
    if (!folder) return
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
      const state = await setPluginEnabled(folder, plugin.id, enabled)
      apply(state.enabled)
      // The plugin's skills join or leave the Cowork skill list.
      invalidateSkills()
      toast.success(
        t(state.enabled ? 'plugins:toggle.enabled' : 'plugins:toggle.disabled', {
          name: plugin.name,
        })
      )
    } catch (e) {
      // Revert: the switch must show what is on disk, not what was asked.
      apply(!enabled)
      setToggleError(
        t('plugins:toggle.failed', {
          name: plugin.name,
          error: pluginErrorText(t, e),
        })
      )
      if (toPluginError(e).code === 'not_installed') void refresh()
    } finally {
      setToggling(null)
    }
  }

  const openInstall = () => {
    setMode('install')
    setSelectedId(null)
    setDetails(null)
    setFieldError(null)
    setInstallError(null)
    setInstallNotice(null)
  }

  const chooseFolder = async () => {
    const picked = await serviceHub.dialog().open({ directory: true })
    const path = Array.isArray(picked) ? picked[0] : picked
    if (path) {
      setLocalPath(path)
      setFieldError(null)
    }
  }

  const gitCheck = checkGitUrl(gitUrl)
  const gitHost = gitCheck.ok ? gitCheck.host : null

  const buildSource = (): InstallSource | null => {
    if (kind === 'local') {
      if (!localPath.trim()) {
        setFieldError(t('plugins:install.errors.pathRequired'))
        return null
      }
      return { kind: 'local', path: localPath.trim() }
    }
    if (kind === 'git') {
      if (!gitCheck.ok) {
        setFieldError(
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
      setFieldError(t('plugins:install.errors.nameRequired'))
      return null
    }
    return { kind: 'marketplace', name: marketName.trim() }
  }

  const startInstall = async () => {
    if (!folder || installing) return
    setFieldError(null)
    setInstallError(null)
    setInstallNotice(null)
    const source = buildSource()
    if (!source) return
    const state: InstallState = {
      id: newOperationId(),
      kind: source.kind,
      host:
        source.kind === 'git'
          ? gitHost
          : source.kind === 'marketplace' && sources?.marketplace
            ? urlHost(sources.marketplace)
            : null,
      cancelling: false,
    }
    installingRef.current = state
    setInstalling(state)
    try {
      const plugin = await installPlugin(folder, source, state.id)
      invalidateSkills()
      toast.success(t('plugins:install.done', { name: plugin.name }))
      await refresh()
      select(plugin.id)
    } catch (e) {
      const err = toPluginError(e)
      if (err.code === 'cancelled') {
        setInstallNotice(t('plugins:install.cancelled'))
      } else {
        setInstallError(t('plugins:install.failed', { error: pluginErrorText(t, err) }))
      }
    } finally {
      installingRef.current = null
      setInstalling(null)
    }
  }

  const cancelInstall = async () => {
    const current = installingRef.current
    if (!current) return
    setInstalling({ ...current, cancelling: true })
    try {
      await cancelPluginInstall(current.id)
    } catch {
      // The install promise still settles and reports the real outcome.
    }
  }

  const confirmRemoval = async () => {
    if (!folder || !confirmRemove) return
    const target = confirmRemove
    setRemoving(true)
    setRemoveError(null)
    try {
      const report = await removePlugin(folder, target.id)
      toast.success(
        t('plugins:remove.done', { name: report.name, path: report.removedPath }),
        report.removedSkillEntries.length > 0 || report.removedFromDisabled
          ? {
              description: t('plugins:remove.doneConfig', {
                entries: [
                  ...(report.removedFromDisabled ? ['[plugins].disabled'] : []),
                  ...report.removedSkillEntries.map((e) => `[skills].enabled "${e}"`),
                ].join(', '),
              }),
            }
          : undefined
      )
      setConfirmRemove(null)
      setSelectedId(null)
      setDetails(null)
      await refresh()
    } catch (e) {
      setRemoveError(
        t('plugins:remove.failed', { name: target.name, error: pluginErrorText(t, e) })
      )
      setConfirmRemove(null)
      void refresh()
    } finally {
      // Also after a failure: the directory may be gone even when the config
      // cleanup that follows it was refused.
      invalidateSkills()
      setRemoving(false)
    }
  }

  const handleOpenChange = (next: boolean) => {
    // Closing mid-install cancels it rather than leaving it running unseen.
    if (!next && installingRef.current) void cancelInstall()
    onOpenChange(next)
  }

  const sourceLabel = (p: InstalledPlugin) =>
    p.sourceKind ? t(`plugins:source.${p.sourceKind}`) : t('plugins:source.unknown')

  const installProgress = (s: InstallState) => {
    if (s.cancelling) return t('plugins:install.cancelling')
    if (s.kind === 'local') return t('plugins:install.copying')
    if (s.kind === 'git') return t('plugins:install.cloning', { host: s.host ?? '' })
    return t('plugins:install.fetchingMarketplace')
  }

  const gitDisabled = sources !== null && !sources.gitAvailable

  const renderList = () => (
    <div className="flex max-h-[40vh] min-h-0 flex-col gap-2 border-b border-border pb-3 sm:max-h-none sm:w-1/3 sm:border-r sm:border-b-0 sm:pr-3 sm:pb-0">
      <Button
        variant="outline"
        size="sm"
        aria-pressed={mode === 'install'}
        className={cn(
          'gap-1.5 justify-start pointer-coarse:h-11',
          mode === 'install' && 'bg-accent text-foreground'
        )}
        onClick={openInstall}
        disabled={installing !== null}
      >
        <Plus size={14} aria-hidden />
        {t('plugins:installButton')}
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
        ) : (
          plugins.map((p) => (
            <PluginListRow
              key={p.id}
              plugin={p}
              isSelected={selectedId === p.id && mode === 'browse'}
              sourceLabel={sourceLabel(p)}
              toggling={toggling === p.id}
              scope={globalExt.getPluginScope(p.id)}
              onSelect={() => select(p.id)}
              onToggle={(enabled) => void toggle(p, enabled)}
              onScopeChange={(s) => globalExt.setPluginScope(p.id, s)}
              onRequestRemove={() => {
                select(p.id)
                void loadDetails(p.id).then((d) => {
                  if (d) setConfirmRemove(d)
                })
              }}
              t={t}
            />
          ))
        )}
      </div>
    </div>
  )

  const renderNames = (label: string, names: string[]) => (
    <div>
      <div className="text-xs font-medium">{label}</div>
      {names.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('plugins:details.none')}</p>
      ) : (
        <ul className="text-xs text-muted-foreground list-disc pl-4">
          {names.map((n) => (
            <li key={n} className="break-all">
              {n}
            </li>
          ))}
        </ul>
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
            <span className="min-w-0">
              {t('plugins:details.failed', { error: detailsError })}
            </span>
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
              {details.gitRef && (
                <>
                  <dt className="text-muted-foreground">{t('plugins:details.gitRef')}</dt>
                  <dd className="break-all">{details.gitRef}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('plugins:details.installedPath')}</dt>
              <dd className="break-all">{details.installedPath}</dd>
              {details.installedAtMs !== null && (
                <>
                  <dt className="text-muted-foreground">{t('plugins:details.installedAt')}</dt>
                  <dd>{new Date(details.installedAtMs).toLocaleString()}</dd>
                </>
              )}
            </dl>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('plugins:details.components')}</h3>
              {renderNames(t('plugins:details.skills'), details.skillNames)}
              {renderNames(t('plugins:details.commands'), details.commandNames)}
              {renderNames(t('plugins:details.agents'), details.agentNames)}
            </section>

            <section className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">{t('plugins:details.access')}</h3>
              <ul className="text-xs text-muted-foreground list-disc pl-4 flex flex-col gap-0.5">
                <li>{t('plugins:details.accessNoPermissions')}</li>
                <li>{t('plugins:details.accessSkills')}</li>
                <li>{t('plugins:details.accessCommands')}</li>
                <li>{t('plugins:details.accessAgents')}</li>
              </ul>
              {details.hasMcpConfig && (
                <p className="text-xs text-muted-foreground border rounded-md px-2 py-1.5">
                  {t('plugins:details.mcpPresent')}
                </p>
              )}
              {details.executableFileCount > 0 && (
                <div>
                  <div className="text-xs font-medium">
                    {t('plugins:details.executables', {
                      count: details.executableFileCount,
                    })}
                  </div>
                  <ul className="text-xs text-muted-foreground list-disc pl-4">
                    {details.executableFiles.map((f) => (
                      <li key={f} className="break-all font-mono">
                        {f}
                      </li>
                    ))}
                  </ul>
                  {details.executableFileCount > details.executableFiles.length && (
                    <p className="text-xs text-muted-foreground">
                      {t('plugins:details.executablesMore', {
                        count: details.executableFileCount - details.executableFiles.length,
                      })}
                    </p>
                  )}
                </div>
              )}
            </section>

            <div>
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5 pointer-coarse:h-11"
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

  const renderInstall = () => {
    const busy = installing !== null
    const describedBy = [fieldError ? fieldErrorId : null, noticeId]
      .filter(Boolean)
      .join(' ')
    return (
      <form
        className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pr-1"
        onSubmit={(e) => {
          e.preventDefault()
          void startInstall()
        }}
      >
        <div className="text-sm font-medium">{t('plugins:install.title')}</div>
        <fieldset className="flex flex-col gap-2" disabled={busy}>
          <legend className="text-xs text-muted-foreground mb-1">
            {t('plugins:install.sourceLabel')}
          </legend>
          <RadioGroup
            value={kind}
            onValueChange={(v) => {
              setKind(v as PluginSourceKind)
              setFieldError(null)
            }}
            className="gap-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id="plugin-source-local" value="local" />
              <Label htmlFor="plugin-source-local">{t('plugins:install.local')}</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="plugin-source-git" value="git" disabled={gitDisabled} />
              <Label htmlFor="plugin-source-git">{t('plugins:install.git')}</Label>
            </div>
            {sources?.marketplace && (
              <div className="flex items-center gap-2">
                <RadioGroupItem
                  id="plugin-source-marketplace"
                  value="marketplace"
                  disabled={gitDisabled}
                />
                <Label htmlFor="plugin-source-marketplace">
                  {t('plugins:install.marketplace')}
                </Label>
              </div>
            )}
          </RadioGroup>
          {gitDisabled && (
            <p className="text-xs text-muted-foreground">{t('plugins:install.gitUnavailable')}</p>
          )}
        </fieldset>

        {kind === 'local' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plugin-local-path">{t('plugins:install.localPathLabel')}</Label>
            <div className="flex gap-2">
              <Input
                id="plugin-local-path"
                value={localPath}
                disabled={busy}
                placeholder={t('plugins:install.localPathPlaceholder')}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={describedBy}
                onChange={(e) => {
                  setLocalPath(e.target.value)
                  setFieldError(null)
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 shrink-0"
                disabled={busy}
                onClick={() => void chooseFolder()}
              >
                <FolderOpen size={14} />
                {t('plugins:install.chooseFolder')}
              </Button>
            </div>
            <p id={noticeId} className="text-xs text-muted-foreground">
              {t('plugins:install.localNotice')}
            </p>
          </div>
        )}

        {kind === 'git' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plugin-git-url">{t('plugins:install.gitUrlLabel')}</Label>
            <Input
              id="plugin-git-url"
              value={gitUrl}
              disabled={busy}
              placeholder={t('plugins:install.gitUrlPlaceholder')}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={describedBy}
              onChange={(e) => {
                setGitUrl(e.target.value)
                setFieldError(null)
              }}
            />
            <p id={noticeId} className="text-xs text-muted-foreground">
              {gitHost
                ? t('plugins:install.gitNotice', { host: gitHost })
                : t('plugins:install.gitNoticeNoHost')}
            </p>
          </div>
        )}

        {kind === 'marketplace' && sources?.marketplace && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plugin-market-name">
              {t('plugins:install.marketplaceNameLabel')}
            </Label>
            <Input
              id="plugin-market-name"
              value={marketName}
              disabled={busy}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={describedBy}
              onChange={(e) => {
                setMarketName(e.target.value)
                setFieldError(null)
              }}
            />
            <p id={noticeId} className="text-xs text-muted-foreground">
              {t('plugins:install.marketplaceNotice', {
                host: urlHost(sources.marketplace),
              })}
            </p>
          </div>
        )}

        {fieldError && (
          <p id={fieldErrorId} role="alert" className={ALERT}>
            <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{fieldError}</span>
          </p>
        )}
        {installError && (
          <p role="alert" className={ALERT}>
            <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{installError}</span>
          </p>
        )}
        {installNotice && (
          <p role="status" className="text-xs text-muted-foreground">
            {installNotice}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          {installing ? (
            <>
              <span role="status" className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="motion-safe:animate-spin" size={12} aria-hidden />
                {installProgress(installing)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={installing.cancelling}
                onClick={() => void cancelInstall()}
              >
                {t('plugins:install.cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setMode('browse')}
              >
                {t('plugins:install.back')}
              </Button>
              <Button type="submit" size="sm">
                {t('plugins:install.submit')}
              </Button>
            </>
          )}
        </div>
      </form>
    )
  }

  const renderEmpty = () => (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-6">
      <Puzzle className="text-muted-foreground" size={20} />
      <div className="text-sm font-medium">{t('plugins:empty.title')}</div>
      <p className="text-xs text-muted-foreground">{t('plugins:empty.body')}</p>
      <Button size="sm" className="gap-1.5" onClick={openInstall}>
        <Plus size={14} />
        {t('plugins:installButton')}
      </Button>
    </div>
  )

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('plugins:title')}</DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-1 text-xs">
                <p>{t('plugins:whatIs')}</p>
                <p>{t('plugins:whereApplies')}</p>
                <p>{t('plugins:whenApplies')}</p>
              </div>
            </DialogDescription>
          </DialogHeader>

          {!folder ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {t('plugins:selectFolder')}
            </div>
          ) : (
            <div className="flex min-h-0 flex-col gap-3 sm:h-[60vh] sm:flex-row sm:gap-4 sm:overflow-hidden">
              {renderList()}
              <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2">
                {mode === 'install'
                  ? renderInstall()
                  : !loading && !loadError && plugins.length === 0
                    ? renderEmpty()
                    : renderDetails()}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmRemove !== null}
        onOpenChange={(next) => {
          if (!next && !removing) setConfirmRemove(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('plugins:remove.title', { name: confirmRemove?.name ?? '' })}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-2 text-sm">
                <p className="break-all">
                  {t('plugins:remove.body', { path: confirmRemove?.installedPath ?? '' })}
                </p>
                <p>{t('plugins:remove.config', { name: confirmRemove?.id ?? '' })}</p>
                <p>{t('plugins:remove.sourceKept')}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={removing}
              onClick={() => setConfirmRemove(null)}
            >
              {t('plugins:remove.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={removing}
              onClick={() => void confirmRemoval()}
            >
              {removing && (
                <Loader2 className="motion-safe:animate-spin" size={14} aria-hidden />
              )}
              {t('plugins:remove.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
