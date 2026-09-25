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
import { EyeOff, Eye, ChevronsUpDown } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  useWebSearchConfig,
  WEB_SEARCH_PROVIDERS,
  getProviderMeta,
  providerInitial,
} from '@/hooks/useWebSearchConfig'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.web_search as any)({
  component: WebSearchContent,
})

const ProviderFavicon = ({ initial }: { initial: string }) => (
  <span aria-hidden className="size-4 shrink-0 inline-flex items-center justify-center rounded-full border border-border-strong bg-muted text-[0.5rem] font-medium uppercase text-fg-2">
    {initial}
  </span>
)

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
                    size="sm"
                    className="max-w-full justify-between gap-2 pointer-coarse:h-11"
                  >
                    <ProviderFavicon initial={providerInitial(provider)} />
                    <span className="truncate">{provider.label}</span>
                    <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
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
                      <ProviderFavicon initial={providerInitial(p)} />
                      <span className="truncate">{p.label}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
          {/* The same anchor id on both branches, never a wrapper around
              them: the provider decides which control exists, so exactly
              one branch is ever mounted and the id stays unique — while a
              wrapper would make the row both first and last child and
              strip the card's dividers. */}
          {provider.requiresEndpoint ? (
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
              className="block"
              description={
                <div className="space-y-2">
                  <p>
                    {t(
                      provider.keyless
                        ? 'settings:webSearch.apiKeyOptional'
                        : 'settings:webSearch.apiKeyRequired',
                      { provider: provider.label }
                    )}
                  </p>
                  <div className="relative">
                    <Input
                      type={showKey ? 'text' : 'password'}
                      className="w-full pr-12 font-mono"
                      placeholder={t(
                        'settings:webSearch.apiKeyPlaceholder',
                        { provider: provider.label }
                      )}
                      value={apiKey}
                      onChange={(e) =>
                        setApiKey(provider.id, e.target.value)
                      }
                    />
                    <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1">
                      <button
                        type="button"
                        aria-label={
                          showKey
                            ? t('settings:webSearch.hideKey')
                            : t('settings:webSearch.showKey')
                        }
                        aria-pressed={showKey}
                        onClick={() => setShowKey(!showKey)}
                        className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover-row hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-10"
                      >
                        {showKey ? (
                          <EyeOff size={16} />
                        ) : (
                          <Eye size={16} />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              }
            />
          )}
        </Card>
      </SettingsPageBody>
    </div>
  )
}
