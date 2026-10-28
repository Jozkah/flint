import { EDITABLE_ENDPOINT } from '@/lib/providerDetailHelpers'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useCallback, useEffect, useState } from 'react'
import { azureApiVersionSetting } from '@/lib/model-factory'
import { API_KEY_FALLBACKS_SETTING_KEY, serializeApiKeyFallbacks } from '@/lib/provider-api-keys'

type ProviderOf = ReturnType<typeof useModelProvider.getState>['providers'][number]

/**
 * The provider page's editable drafts: API keys (one per line, the first is
 * the primary), the base URL of an editable endpoint and Azure's api-version.
 * Each commits on blur; the drafts follow the stored values when the provider
 * or its stored values change.
 */
export function useApiKeyDrafts({
  provider,
  providerName,
  serviceHub,
  updateProvider,
}: {
  provider: ProviderOf | undefined
  providerName: string
  serviceHub: ReturnType<typeof useServiceHub>
  updateProvider: ReturnType<typeof useModelProvider.getState>['updateProvider']
}) {
  const [apiKeysDraft, setApiKeysDraft] = useState('')
  const [baseUrlDraft, setBaseUrlDraft] = useState('')
  const [apiVersionDraft, setApiVersionDraft] = useState('')
  const [showAdvancedApiKeys, setShowAdvancedApiKeys] = useState(false)

  useEffect(() => {
    if (!provider || !EDITABLE_ENDPOINT[provider.provider]) return
    setBaseUrlDraft(provider.base_url ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerName, provider?.base_url])

  const commitApiKeysDraft = useCallback(() => {
    if (!provider) return
    const lines = apiKeysDraft
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const nextPrimary = lines[0] ?? ''
    const nextFallbacks = lines.slice(1)

    const prevPrimary = provider.api_key ?? ''
    const prevFallbacks = provider.api_key_fallbacks ?? []
    const changed =
      nextPrimary !== prevPrimary ||
      JSON.stringify(nextFallbacks) !== JSON.stringify(prevFallbacks)
    if (!changed) return

    const newSettings = [...provider.settings]
    const apiKeySettingIndex = newSettings.findIndex((s) => s.key === 'api-key')
    if (apiKeySettingIndex !== -1) {
      const apiKeyProps = newSettings[apiKeySettingIndex].controller_props as {
        value: string | boolean | number
      }
      apiKeyProps.value = nextPrimary
    }

    const fallbacksValue = serializeApiKeyFallbacks(nextFallbacks)
    const fallbacksIndex = newSettings.findIndex(
      (s) => s.key === API_KEY_FALLBACKS_SETTING_KEY
    )
    if (fallbacksIndex !== -1) {
      const props = newSettings[fallbacksIndex].controller_props as {
        value: string | boolean | number
      }
      props.value = fallbacksValue
    } else if (fallbacksValue.length > 0) {
      newSettings.push({
        key: API_KEY_FALLBACKS_SETTING_KEY,
        title: 'API Key Fallbacks',
        description: '',
        controller_type: 'input',
        controller_props: {
          value: fallbacksValue,
          type: 'password',
          placeholder: '',
        },
      } as (typeof newSettings)[number])
    }

    serviceHub.providers().updateSettings(providerName, newSettings)
    updateProvider(providerName, {
      ...provider,
      settings: newSettings,
      api_key: nextPrimary,
      api_key_fallbacks: nextFallbacks,
      // Built-in providers start switched off; giving one its first key is
      // the user asking to use it.
      ...(nextPrimary && !prevPrimary ? { active: true } : {}),
    })
    // Clearing the key is an explicit user action: purge the keyring secret so
    // it isn't re-seeded into memory on the next launch. (register handles the
    // non-empty case via boot sync -> register_provider_config.)
    if (nextPrimary.length === 0 && nextFallbacks.length === 0) {
      serviceHub.providers().deleteProviderKeys(providerName)
    }
  }, [apiKeysDraft, provider, providerName, serviceHub, updateProvider])

  // Azure's legacy deployments-style endpoints take an api-version the URL may
  // not carry; it lives in the provider's `api-version` setting.
  // The draft follows the stored value (provider switch, import, reset), so a
  // stale draft can never be committed over a newer stored value.
  const storedApiVersion =
    provider?.provider === 'azure' ? azureApiVersionSetting(provider) : null
  useEffect(() => {
    if (storedApiVersion !== null) setApiVersionDraft(storedApiVersion)
  }, [providerName, storedApiVersion])

  const commitApiVersionDraft = useCallback(() => {
    if (!provider || provider.provider !== 'azure') return
    const next = apiVersionDraft.trim()
    if (next === azureApiVersionSetting(provider)) return
    const settings = provider.settings.some((s) => s.key === 'api-version')
      ? provider.settings.map((s) =>
          s.key === 'api-version'
            ? ({
                ...s,
                controller_props: { ...s.controller_props, value: next },
              } as ProviderSetting)
            : s
        )
      : provider.settings
    serviceHub.providers().updateSettings(providerName, settings)
    updateProvider(providerName, { ...provider, settings })
  }, [apiVersionDraft, provider, providerName, serviceHub, updateProvider])

  const commitBaseUrlDraft = useCallback(() => {
    if (!provider || !EDITABLE_ENDPOINT[provider.provider]) return
    const next = baseUrlDraft.trim()
    if (next === (provider.base_url ?? '')) return
    updateProvider(providerName, { ...provider, base_url: next })
  }, [baseUrlDraft, provider, providerName, updateProvider])

  const rawApiKeyLines = apiKeysDraft.split(/\r?\n/)
  const primaryKeyDraft = (rawApiKeyLines[0] ?? '').trim()
  const setPrimaryKeyDraft = (nextPrimary: string) => {
    const rest = rawApiKeyLines.slice(1)
    setApiKeysDraft([nextPrimary, ...rest].join('\n'))
  }

  const advancedApiKeyLines = apiKeysDraft.split(/\r?\n/).map((l) => l.trim())
  const setKeyAtIndex = (index: number, nextValue: string) => {
    const next = [...advancedApiKeyLines]
    next[index] = nextValue.trim()
    setApiKeysDraft(next.join('\n'))
  }

  const addKeyLine = () => {
    setApiKeysDraft([...advancedApiKeyLines, ''].join('\n'))
  }

  const removeKeyLine = (index: number) => {
    if (index === 0) return
    const next = advancedApiKeyLines.filter((_, i) => i !== index)
    setApiKeysDraft((next.length > 0 ? next : ['']).join('\n'))
  }

  return {
    apiKeysDraft,
    setApiKeysDraft,
    baseUrlDraft,
    setBaseUrlDraft,
    apiVersionDraft,
    setApiVersionDraft,
    showAdvancedApiKeys,
    setShowAdvancedApiKeys,
    commitApiKeysDraft,
    commitApiVersionDraft,
    commitBaseUrlDraft,
    primaryKeyDraft,
    setPrimaryKeyDraft,
    advancedApiKeyLines,
    setKeyAtIndex,
    addKeyLine,
    removeKeyLine,
  }
}
