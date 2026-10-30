import { Loader2, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { MarketEntry } from '@/lib/pluginStore'
import { PluginAlert } from './PluginAlert'

type Props = {
  configured: boolean
  query: string
  onQueryChange: (query: string) => void
  onSearch: () => void
  searching: boolean
  searchError: string | null
  entries: MarketEntry[]
  installingName: string | null
  onInstall: (entry: MarketEntry) => void
}

/** The side panel's marketplace search, as a compact list. */
export function PluginBrowsePane({
  configured,
  query,
  onQueryChange,
  onSearch,
  searching,
  searchError,
  entries,
  installingName,
  onInstall,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {!configured ? (
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
              onSearch()
            }}
          >
            <Input
              value={query}
              placeholder={t('plugins:install.marketplaceNameLabel')}
              onChange={(e) => onQueryChange(e.target.value)}
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
          {searchError && <PluginAlert>{searchError}</PluginAlert>}
          <div className="flex flex-col gap-1" role="list" aria-label={t('plugins:browseButton')}>
            {entries.map((entry, i) => (
              <div
                key={`${entry.name}-${i}`}
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
                  onClick={() => onInstall(entry)}
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
}
