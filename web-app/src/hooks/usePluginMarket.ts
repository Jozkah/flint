import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { newPluginOperationId } from '@/hooks/usePluginManager'
import {
  installPlugin,
  pluginErrorText,
  searchPlugins,
  type InstalledPlugin,
  type MarketEntry,
} from '@/lib/pluginStore'

/**
 * The global marketplace: a query, its results, and installing one entry by
 * name. `onInstalled` runs after a successful install (refresh, select).
 */
export function usePluginMarket(onInstalled: (plugin: InstalledPlugin) => Promise<void>) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<MarketEntry[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [installingName, setInstallingName] = useState<string | null>(null)

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
      const operationId = newPluginOperationId()
      const plugin = await installPlugin(
        '',
        { kind: 'marketplace', name: entry.name },
        operationId,
        'global'
      )
      await onInstalled(plugin)
    } catch (e) {
      toast.error(t('plugins:install.failed', { error: pluginErrorText(t, e) }))
    } finally {
      setInstallingName(null)
    }
  }

  return {
    query,
    setQuery,
    entries,
    searching,
    searchError,
    setSearchError,
    installingName,
    runSearch,
    installFromMarket,
  }
}
