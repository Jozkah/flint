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
import { EyeOff, Eye, Search } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  useWebSearchConfig,
  WEB_SEARCH_PROVIDERS,
  getProviderMeta,
  type WebSearchProviderMeta,
} from '@/hooks/useWebSearchConfig'
import { Icon } from '@/components/ui/icon'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.web_search as any)({
  component: WebSearchContent,
})

/**
 * Use each provider's own favicon instead of an unrelated initial badge. The
 * request goes directly to the provider whose mark is being shown (never to a
 * favicon aggregation/tracking service); a blocked or missing favicon falls
 * back to a neutral search glyph rather than a fake brand mark.
 */
const ProviderFavicon = ({ provider }: { provider: WebSearchProviderMeta }) => {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span
        aria-hidden
        className="size-4 shrink-0 inline-flex items-center justify-center rounded-sm bg-muted text-fg-2"
      >
        <Search className="size-3" />
      </span>
    )
  }
  return (
    <img
      aria-hidden
      alt=""
      src={`https://${provider.homepage}/favicon.ico`}
      className="size-4 shrink-0 rounded-sm object-contain"
      onError={() => setFailed(true)}
    />
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
      </SettingsPageBody>
    </div>
  )
}
