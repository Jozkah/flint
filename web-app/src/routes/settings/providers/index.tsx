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
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.model_providers as any)({
  component: ModelProviders,
})

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
      <SettingsPageBody>
        {/* Global settings */}
        <Card
          header={
            <h2 className="mb-4 font-display text-xl font-normal text-foreground">
              {t('provider:globalSettings')}
            </h2>
          }
        >
          <CardItem
            title={t('provider:stripReasoning')}
            description={t('provider:stripReasoningDesc')}
            actions={
              <Switch
                checked={stripReasoningFromContext}
                onCheckedChange={setStripReasoningFromContext}
              />
            }
          />
        </Card>
        {/* Model Providers */}
        <Card
          header={
            <h2 className="mb-4 font-display text-xl font-normal text-foreground">
              {t('common:modelProviders')}
            </h2>
          }
        >
          {providers
            .filter((provider) => IS_MACOS || provider.provider !== 'mlx')
            .map((provider, index) => (
              <CardItem
                key={index}
                title={
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-sunken">
                      <ProvidersAvatar provider={provider} />
                    </span>
                    <div className="min-w-0">
                      <h3 className="truncate font-medium text-foreground">
                        {getProviderTitle(provider.provider)}
                      </h3>
                      <p className="mt-0.5 text-xs font-normal tabular-nums text-muted-foreground">
                        {provider.models.length} Models
                      </p>
                    </div>
                  </div>
                }
                actions={
                  <div className="flex items-center justify-end gap-2">
                    {provider.active && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="pointer-coarse:size-11"
                        aria-label={t('providers:openProvider', {
                          provider: getProviderTitle(provider.provider),
                        })}
                        onClick={() => {
                          navigate({
                            to: route.settings.providers,
                            params: {
                              providerName: provider.provider,
                            },
                          })
                        }}
                      >
                        <ChevronRight className="text-muted-foreground" />
                      </Button>
                    )}
                    <Switch
                      checked={provider.active}
                      aria-label={t('providers:useProvider', {
                        provider: getProviderTitle(provider.provider),
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
                }
              />
            ))}
        </Card>
      </SettingsPageBody>
    </div>
  )
}
