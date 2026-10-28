import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { Card, CardItem } from '@/containers/Card'
import { WEB_SEARCH_PROVIDER_CONFIG_ANCHOR } from '@/lib/settingsSearch'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Input } from '@/components/ui/input'
import { SiteIcon } from '@/components/SiteIcon'
import { EyeOff, Eye, Search, ArrowUp, ArrowDown, X, Plus } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  useWebSearchConfig,
  WEB_SEARCH_PROVIDERS,
  getProviderMeta,
  buildSearchChain,
  chainEntryId,
  chainEntryOptions,
  entryUsesKey,
  type SearchChainEntry,
  type WebSearchProviderMeta,
} from '@/hooks/useWebSearchConfig'
import { Icon } from '@/components/ui/icon'

 
export const Route = createFileRoute(route.settings.web_search)({
  component: WebSearchContent,
})

/**
 * Each provider's own favicon, requested from the provider's own site only (no
 * favicon aggregation service). It follows the "Load site icons" setting: off,
 * no vendor is contacted and the neutral search glyph shows instead.
 */
const ProviderFavicon = ({ provider }: { provider: WebSearchProviderMeta }) => (
  <SiteIcon
    url={`https://${provider.homepage}`}
    className="size-4 shrink-0 rounded-sm object-contain"
    fallback={
      <span
        aria-hidden
        className="size-4 shrink-0 inline-flex items-center justify-center rounded-sm bg-muted text-fg-2"
      >
        <Search className="size-3" />
      </span>
    }
  />
)

const iconButton =
  'grid size-6 shrink-0 place-items-center rounded-md text-secondary-foreground hover:bg-hover-btn hover:text-foreground disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11'

/**
 * The ordered search chain: reorder, switch off, remove and add entries. An
 * entry that cannot run (keyed without a key, SearXNG without a URL) is shown
 * but marked, since the search skips it.
 */
function SearchOrder() {
  const { t } = useTranslation()
  const { searchChain, apiKeys, endpoints, setSearchChain } = useWebSearchConfig()
  const runnable = (entry: SearchChainEntry) =>
    buildSearchChain({ searchChain: [{ ...entry, enabled: true }], apiKeys, endpoints })
      .length > 0
  const label = (e: Pick<SearchChainEntry, 'provider' | 'useKey'>) => {
    const meta = getProviderMeta(e.provider)
    const both = meta.keyless && !!meta.secretKey
    if (!both) return meta.label
    return `${meta.label} (${t(
      entryUsesKey(e) ? 'settings:webSearch.modeKey' : 'settings:webSearch.modeKeyless'
    )})`
  }
  const move = (from: number, to: number) => {
    const next = [...searchChain]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    setSearchChain(next)
  }
  const present = new Set(searchChain.map(chainEntryId))
  const addable = chainEntryOptions().filter((o) => !present.has(chainEntryId(o)))
  const noneOn = buildSearchChain({ searchChain, apiKeys, endpoints }).length === 0

  return (
    <Card title={t('settings:webSearch.searchOrder')}>
      <CardItem
        anchor="settings-web-search-order"
        title={t('settings:webSearch.searchOrder')}
        description={
          noneOn
            ? t('settings:webSearch.emptyChain')
            : t('settings:webSearch.searchOrderDesc')
        }
        actions={
          addable.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="gap-1 pointer-coarse:h-11">
                  <Plus size={14} />
                  {t('settings:webSearch.addEntry')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {addable.map((o) => (
                  <DropdownMenuItem
                    key={chainEntryId(o)}
                    className="cursor-pointer my-0.5 gap-2"
                    onClick={() =>
                      setSearchChain([...searchChain, { ...o, enabled: true }])
                    }
                  >
                    <ProviderFavicon provider={getProviderMeta(o.provider)} />
                    <span className="truncate">{label(o)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      />
      {searchChain.map((entry, i) => (
        <CardItem
          key={chainEntryId(entry)}
          title={
            <span className="flex items-center gap-2">
              <span className="w-4 text-right tabular-nums text-fg-2">{i + 1}</span>
              <ProviderFavicon provider={getProviderMeta(entry.provider)} />
              <span className={cn('truncate', !entry.enabled && 'opacity-50')}>
                {label(entry)}
              </span>
            </span>
          }
          description={
            entry.enabled && !runnable(entry)
              ? t('settings:webSearch.needsSetup')
              : undefined
          }
          actions={
            <span className="flex items-center gap-1">
              <button
                type="button"
                aria-label={t('settings:webSearch.moveUp')}
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
                className={iconButton}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                aria-label={t('settings:webSearch.moveDown')}
                disabled={i === searchChain.length - 1}
                onClick={() => move(i, i + 1)}
                className={iconButton}
              >
                <ArrowDown size={14} />
              </button>
              <Switch
                aria-label={label(entry)}
                checked={entry.enabled}
                onCheckedChange={(enabled) =>
                  setSearchChain(
                    searchChain.map((e, j) => (j === i ? { ...e, enabled } : e))
                  )
                }
              />
              <button
                type="button"
                aria-label={t('settings:webSearch.removeEntry')}
                onClick={() => setSearchChain(searchChain.filter((_, j) => j !== i))}
                className={iconButton}
              >
                <X size={14} />
              </button>
            </span>
          }
        />
      ))}
    </Card>
  )
}

function WebSearchContent() {
  const { t } = useTranslation()
  const [showKey, setShowKey] = useState(false)
  const {
    webSearchEnabled,
    searchProvider,
    apiKeys,
    endpoints,
    setWebSearchEnabled,
    setSearchProvider,
    setApiKey,
    setEndpoint,
  } = useWebSearchConfig()

  const provider = getProviderMeta(searchProvider)
  const apiKey = apiKeys[provider.id] ?? ''
  const endpoint = endpoints[provider.id] ?? ''

  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader title={t('common:web_search')} />
      <SettingsPageBody
        title={t('common:web_search')}
        description={t('settings:pageDesc.webSearch')}
      >
        <Card title={t('settings:webSearch.title')}>
          <CardItem
            anchor="settings-web-search-enable"
            title={t('settings:webSearch.enable')}
            description={t('settings:webSearch.enableDesc')}
            actions={
              <Switch
                aria-label={t('settings:webSearch.enable')}
                checked={webSearchEnabled}
                onCheckedChange={setWebSearchEnabled}
              />
            }
          />
          <CardItem
            title={t('settings:webSearch.provider')}
            description={t('settings:webSearch.providerDesc')}
            actions={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="max-w-full justify-between gap-2 pointer-coarse:h-11"
                  >
                    <ProviderFavicon key={provider.id} provider={provider} />
                    <span className="truncate">{provider.label}</span>
                    <Icon name="arrow-down" size={12} className="ml-2 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  {WEB_SEARCH_PROVIDERS.map((p) => (
                    <DropdownMenuItem
                      key={p.id}
                      className={cn(
                        'cursor-pointer my-0.5 gap-2',
                        searchProvider === p.id && 'bg-accent'
                      )}
                      onClick={() => setSearchProvider(p.id)}
                    >
                      <ProviderFavicon key={p.id} provider={p} />
                      <span className="truncate">{p.label}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
          {/* The same anchor id on every branch, never a wrapper around
              them: the provider decides which control exists, so exactly
              one branch is ever mounted and the id stays unique — while a
              wrapper would make the row both first and last child and
              strip the card's dividers. */}
          {provider.noSetup ? (
            <CardItem
              anchor={WEB_SEARCH_PROVIDER_CONFIG_ANCHOR}
              title={t('settings:webSearch.noSetup', {
                provider: provider.label,
              })}
              description={t('settings:webSearch.noSetupDesc', {
                provider: provider.label,
              })}
            />
          ) : provider.requiresEndpoint ? (
            <CardItem
              anchor={WEB_SEARCH_PROVIDER_CONFIG_ANCHOR}
              title={t('settings:webSearch.endpoint', {
                provider: provider.label,
              })}
              className="block"
              description={
                <div className="space-y-2">
                  <p>
                    {t('settings:webSearch.endpointDesc', {
                      provider: provider.label,
                    })}
                  </p>
                  <Input
                    type="text"
                    className="w-full font-mono"
                    aria-label={t('settings:webSearch.endpoint', {
                      provider: provider.label,
                    })}
                    placeholder={t(
                      'settings:webSearch.endpointPlaceholder'
                    )}
                    value={endpoint}
                    onChange={(e) =>
                      setEndpoint(provider.id, e.target.value)
                    }
                  />
                </div>
              }
            />
          ) : (
            <CardItem
              anchor={WEB_SEARCH_PROVIDER_CONFIG_ANCHOR}
              title={t('settings:webSearch.apiKey', {
                provider: provider.label,
              })}
              description={t(
                provider.keyless
                  ? 'settings:webSearch.apiKeyOptional'
                  : 'settings:webSearch.apiKeyRequired',
                { provider: provider.label }
              )}
              actions={
                <span className="flex w-full min-w-0 items-center gap-1 sm:w-auto">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    className="min-w-0 flex-1 font-mono sm:w-[220px] sm:flex-none"
                    aria-label={t('settings:webSearch.apiKey', {
                      provider: provider.label,
                    })}
                    placeholder={t('settings:webSearch.apiKeyPlaceholder', {
                      provider: provider.label,
                    })}
                    value={apiKey}
                    onChange={(e) => setApiKey(provider.id, e.target.value)}
                  />
                  <button
                    type="button"
                    aria-label={
                      showKey
                        ? t('settings:webSearch.hideKey')
                        : t('settings:webSearch.showKey')
                    }
                    aria-pressed={showKey}
                    onClick={() => setShowKey(!showKey)}
                    className="grid size-6 shrink-0 place-items-center rounded-md text-secondary-foreground hover:bg-hover-btn hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
                  >
                    {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </span>
              }
            />
          )}
        </Card>
        <SearchOrder />
      </SettingsPageBody>
    </div>
  )
}
