import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useNavigate } from '@tanstack/react-router'
import { ChevronRight, Plus } from 'lucide-react'
import { getProviderTitle } from '@/lib/utils'
import { classifyModelLocation } from '@/lib/modelLocation'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { AddProviderDialog } from '@/containers/dialogs'
import { Switch } from '@/components/ui/switch'
import { useCallback } from 'react'
import {
  openAIProviderSettings,
  anthropicProviderSettings,
} from '@/constants/providers'
import cloneDeep from 'lodash/cloneDeep'
import { toast } from 'sonner'
import { useServiceHub } from '@/hooks/useServiceHub'
import { SettingsPageHeader } from '@/containers/SettingsPageHeader'
import { WidePageBody } from '@/containers/WidePageBody'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.model_providers as any)({
  component: ModelProviders,
})

/** Columns of the provider list once its container is wide enough. */
const PROVIDER_GRID =
  '@2xl:grid-cols-[minmax(0,1.4fr)_7rem_minmax(0,1.2fr)_auto]'

function ModelProviders() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { providers, addProvider, updateProvider } = useModelProvider()
  const stripReasoningFromContext = useGeneralSetting(
    (s) => s.stripReasoningFromContext
  )
  const setStripReasoningFromContext = useGeneralSetting(
    (s) => s.setStripReasoningFromContext
  )
  const navigate = useNavigate()

  const createProvider = useCallback(
    (
      name: string,
      baseUrl: string,
      apiKey: string,
      apiType: ProviderApiType
    ) => {
      if (
        providers.some((e) => e.provider.toLowerCase() === name.toLowerCase())
      ) {
        toast.error(t('providerAlreadyExists', { name }))
        return
      }
      const template =
        apiType === 'anthropic'
          ? anthropicProviderSettings
          : openAIProviderSettings
      const settings = cloneDeep(template) as ProviderSetting[]
      for (const s of settings) {
        if (s.key === 'base-url') {
          (s.controller_props as { value: string }).value = baseUrl
        } else if (s.key === 'api-key') {
          (s.controller_props as { value: string }).value = apiKey
        }
      }
      const newProvider: ProviderObject = {
        provider: name,
        active: true,
        models: [],
        settings,
        api_key: apiKey,
        base_url: baseUrl,
        ...(apiType === 'anthropic' ? { api_type: 'anthropic' as const } : {}),
      }
      addProvider(newProvider)
      setTimeout(() => {
        navigate({
          to: route.settings.providers,
          params: {
            providerName: name,
          },
        })
      }, 0)
    },
    [providers, addProvider, t, navigate]
  )

  const openProvider = (providerName: string) =>
    navigate({
      to: route.settings.providers,
      params: { providerName },
    })

  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader>
        <AddProviderDialog onCreateProvider={createProvider}>
          <Button variant="outline" size="sm" className="pointer-coarse:h-11">
            <Plus aria-hidden />
            <span>{t('provider:addProvider')}</span>
          </Button>
        </AddProviderDialog>
      </SettingsPageHeader>
      <WidePageBody>
        {/* Model Providers: a table that grows with the pane. */}
        <Card
          header={
            <h2 className="mb-3 text-[13px] font-semibold text-foreground">
              {t('common:modelProviders')}
            </h2>
          }
        >
          <ul className="@container flex min-w-0 flex-col border-t border-border">
            {providers
              .filter((provider) => IS_MACOS || provider.provider !== 'mlx')
              .map((provider) => {
                const title = getProviderTitle(provider.provider)
                const engine =
                  provider.provider === 'llamacpp' ||
                  provider.provider === 'mlx'
                const location = classifyModelLocation({
                  baseUrl: provider.base_url,
                  builtInEngine: engine,
                })
                const where =
                  location === 'local' || location === 'remote'
                    ? t(`model-fit:location.${location}`)
                    : ''
                const count = `${provider.models.length} Models`
                return (
                  <li
                    key={provider.provider}
                    data-testid={`provider-row-${provider.provider}`}
                    className={`grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-border py-2 last:border-b-0 ${PROVIDER_GRID}`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-sunken">
                        <ProvidersAvatar provider={provider} />
                      </span>
                      <div className="min-w-0">
                        {provider.active ? (
                          <button
                            type="button"
                            onClick={() => openProvider(provider.provider)}
                            className="block max-w-full truncate rounded-sm text-left text-sm font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:min-h-11"
                          >
                            {title}
                          </button>
                        ) : (
                          <h3 className="truncate text-sm font-medium text-foreground">
                            {title}
                          </h3>
                        )}
                        {/* On a narrow pane the columns fold under the name. */}
                        <p className="truncate text-xs tabular-nums text-muted-foreground @2xl:hidden">
                          {where ? `${count} · ${where}` : count}
                        </p>
                      </div>
                    </div>
                    <span className="hidden text-sm tabular-nums text-ink-2 @2xl:block">
                      {count}
                    </span>
                    <span
                      className="hidden truncate text-xs text-muted-foreground @2xl:block"
                      title={where}
                    >
                      {where}
                    </span>
                    <div className="flex items-center justify-end gap-2">
                      {provider.active && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="pointer-coarse:size-11"
                          aria-label={t('providers:openProvider', {
                            provider: title,
                          })}
                          onClick={() => openProvider(provider.provider)}
                        >
                          <ChevronRight className="text-muted-foreground" />
                        </Button>
                      )}
                      <Switch
                        checked={provider.active}
                        aria-label={t('providers:useProvider', {
                          provider: title,
                        })}
                        onCheckedChange={async (e) => {
                          if (
                            !e &&
                            provider.provider.toLowerCase() === 'llamacpp'
                          ) {
                            await serviceHub.models().stopAllModels()
                          }
                          updateProvider(provider.provider, {
                            ...provider,
                            active: e,
                          })
                        }}
                      />
                    </div>
                  </li>
                )
              })}
          </ul>
        </Card>
        {/* Global settings */}
        <Card
          header={
            <h2 className="mb-3 text-[13px] font-semibold text-foreground">
              {t('provider:globalSettings')}
            </h2>
          }
        >
          <CardItem
            title={t('provider:stripReasoning')}
            description={t('provider:stripReasoningDesc')}
            actions={
              <Switch
                aria-label={t('provider:stripReasoning')}
                checked={stripReasoningFromContext}
                onCheckedChange={setStripReasoningFromContext}
              />
            }
          />
        </Card>
      </WidePageBody>
    </div>
  )
}
