import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { invalidateSkills } from '@/hooks/useSkills'
import {
  getPluginDetails,
  getPluginSources,
  listPlugins,
  pluginErrorText,
  removePlugin,
  setPluginEnabled,
  toPluginError,
  updatePlugin,
  type InstalledPlugin,
  type PluginDetails,
  type PluginScope,
  type PluginSources,
} from '@/lib/pluginStore'

/** A fresh id for an install or update, so the backend can tell operations apart. */
export const newPluginOperationId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `install-${Date.now()}-${Math.random().toString(36).slice(2)}`

export type PluginManagerOptions = {
  /** The project folder whose plugins are managed. Ignored when `global`. */
  scopeFolder: string | null
  /** Manage the user's global plugin store instead of one project's. */
  global?: boolean
  /** Load only while true (a closed dialog loads nothing). Default true. */
  active?: boolean
}

/**
 * The list / details / toggle / update / remove flow of an installed-plugins
 * surface, shared by the Extensions page tab (global store) and the Cowork
 * dialog (one project's plugins). What differs between them is the scope
 * arguments, which this hides; the install form and marketplace browsing
 * stay with the surface.
 */
export function usePluginManager({
  scopeFolder,
  global = false,
  active = true,
}: PluginManagerOptions) {
  const { t } = useTranslation()
  const folder = global ? '' : scopeFolder
  // The project calls take no scope argument at all; only the global store does.
  const scope: [] | [PluginScope] = useMemo(() => (global ? ['global'] : []) as [] | [PluginScope], [global])
  // A project surface with no folder has nothing to manage.
  const unavailable = !global && !scopeFolder

  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sources, setSources] = useState<PluginSources | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [details, setDetails] = useState<PluginDetails | null>(null)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

  const [confirmRemove, setConfirmRemove] = useState<PluginDetails | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)

  // Loaders read `t` through a ref so an unstable `t` identity cannot
  // re-trigger the load effect on every render.
  const tRef = useRef(t)
  tRef.current = t

  const refresh = useCallback(async () => {
    if (unavailable) {
      setPlugins([])
      return []
    }
    setLoading(true)
    setLoadError(null)
    try {
      const list = await listPlugins(folder ?? '', ...scope)
      setPlugins(list)
      return list
    } catch (e) {
      setLoadError(pluginErrorText(tRef.current, e))
      return null
    } finally {
      setLoading(false)
    }
  }, [folder, scope, unavailable])

  useEffect(() => {
    if (!active || unavailable) return
    void refresh()
    getPluginSources(folder ?? '', ...scope)
      .then(setSources)
      // Unknown sources are not an error worth blocking on: the install
      // itself reports a missing git or marketplace precisely.
      .catch(() => setSources(null))
  }, [active, unavailable, folder, scope, refresh])

  // Reset per-folder state when the project changes.
  useEffect(() => {
    setSelectedId(null)
    setDetails(null)
  }, [folder])

  // The plugin whose details were asked for last. A slower request for a
  // plugin the user already left must not overwrite the current one's details
  // (the pane would then show "loading" forever).
  const detailsForRef = useRef<string | null>(null)

  const loadDetails = useCallback(
    async (id: string): Promise<PluginDetails | null> => {
      if (unavailable) return null
      detailsForRef.current = id
      setDetails(null)
      setDetailsError(null)
      try {
        const d = await getPluginDetails(folder ?? '', id, ...scope)
        if (detailsForRef.current === id) setDetails(d)
        return d
      } catch (e) {
        if (detailsForRef.current === id) {
          setDetailsError(pluginErrorText(tRef.current, e))
        }
        if (toPluginError(e).code === 'not_installed') void refresh()
        return null
      }
    },
    [folder, scope, unavailable, refresh]
  )

  /** Selects a plugin and loads its details. */
  const select = (id: string) => {
    setSelectedId(id)
    setToggleError(null)
    setRemoveError(null)
    setUpdateError(null)
    void loadDetails(id)
  }

  const toggle = async (plugin: InstalledPlugin, enabled: boolean) => {
    if (unavailable) return
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
      const state = await setPluginEnabled(folder ?? '', plugin.id, enabled, ...scope)
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

  const runUpdate = async (plugin: PluginDetails) => {
    if (unavailable) return
    setUpdating(plugin.id)
    setRemoveError(null)
    setUpdateError(null)
    try {
      const report = await updatePlugin(
        folder ?? '',
        plugin.id,
        newPluginOperationId(),
        ...scope
      )
      toast.success(
        report.updated
          ? t('plugins:update.done', { name: plugin.name })
          : t('plugins:update.upToDate', { name: plugin.name })
      )
      if (report.updated) invalidateSkills()
      await refresh()
      await loadDetails(report.id)
    } catch (e) {
      setUpdateError(
        t('plugins:update.failed', { name: plugin.name, error: pluginErrorText(t, e) })
      )
    } finally {
      setUpdating(null)
    }
  }

  const confirmRemoval = async () => {
    if (unavailable || !confirmRemove) return
    const target = confirmRemove
    setRemoving(true)
    setRemoveError(null)
    setUpdateError(null)
    try {
      const report = await removePlugin(folder ?? '', target.id, ...scope)
      toast.success(
        t('plugins:remove.done', { name: report.name, path: report.removedPath }),
        // Config entries are cleaned per project; the global store has none.
        !global &&
          (report.removedSkillEntries.length > 0 || report.removedFromDisabled)
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

  return {
    folder,
    scope,
    unavailable,
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
    loadDetails,
    select,
    toggle,
    runUpdate,
    confirmRemoval,
  }
}
