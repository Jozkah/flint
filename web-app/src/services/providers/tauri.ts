/**
 * Tauri Providers Service - Desktop implementation
 */

import { predefinedProviders } from '@/constants/providers'
import { providerModels } from '@/constants/models'
import { EngineManager, SettingComponentProps } from '@janhq/core'
import { ModelCapabilities } from '@/types/models'
import { modelSettings } from '@/lib/predefined'
import { ExtensionManager } from '@/lib/extension'
import { providerFetch as fetchTauri } from '@/lib/providerFetch'
import { invoke } from '@tauri-apps/api/core'
import { DefaultProvidersService } from './default'
import { getModelCapabilities } from '@/lib/models'
import {
  API_KEY_FALLBACKS_SETTING_KEY,
  providerRemoteApiKeyChain,
} from '@/lib/provider-api-keys'
import { ensureAnthropicHeaders } from '@/lib/anthropicHeaders'
import { applyCustomHeaders } from '@/lib/customHeaders'
import {
  EndpointError,
  describeEndpointFailure,
  isEndpointError,
  parseModelList,
} from '@/lib/endpointDiagnostics'
import { modelsUrlCandidates } from '@/lib/modelsUrl'

export class TauriProvidersService extends DefaultProvidersService {
  fetch(): typeof fetch {
    // The canonical provider transport: no CORS, and one endpoint-resolution
    // rule shared with chat completions, embeddings and connection tests.
    return fetchTauri as typeof fetch
  }

  async getProviders(): Promise<ModelProvider[]> {
    try {
      const builtinProviders = predefinedProviders.map((provider) => {
        let models = provider.models as Model[]
        if (Object.keys(providerModels).includes(provider.provider)) {
          const builtInModels = providerModels[
            provider.provider as unknown as keyof typeof providerModels
          ].models as unknown as string[]

          if (Array.isArray(builtInModels)) {
            models = builtInModels.map((model) => {
              const modelManifest = models.find((e) => e.id === model)
              // TODO: Check chat_template for tool call support
              return {
                ...(modelManifest ?? { id: model, name: model }),
                capabilities: getModelCapabilities(provider.provider, model),
              } as Model
            })
          }
        }

        return {
          ...provider,
          models,
        }
      }).filter(Boolean)

      const runtimeProviders: ModelProvider[] = []
      for (const [providerName, value] of EngineManager.instance().engines) {
        const models = await value.list() ?? []
        const provider: ModelProvider = {
          active: false,
          persist: true,
          provider: providerName,
          base_url:
            'inferenceUrl' in value
              ? (value.inferenceUrl as string).replace('/chat/completions', '')
              : '',
          settings: (await value.getSettings()).map((setting) => {
            return {
              key: setting.key,
              title: setting.title,
              description: setting.description,
              controller_type: setting.controllerType as unknown,
              controller_props: setting.controllerProps as unknown,
            }
          }) as ProviderSetting[],
          models: await Promise.all(
            models.map(async (model) => {
              let capabilities: string[] = []

              if ('capabilities' in model && Array.isArray(model.capabilities)) {
                capabilities = [...(model.capabilities as string[])]
              }
              if (!capabilities.includes(ModelCapabilities.TOOLS)) {
                try {
                  const toolSupported = await value.isToolSupported(model.id)
                  if (toolSupported) {
                    capabilities.push(ModelCapabilities.TOOLS)
                  }
                } catch (error) {
                  console.warn(
                    `Failed to check tool support for model ${model.id}:`,
                    error
                  )
                  // Continue without tool capabilities if check fails
                }
              }

              // Add embeddings capability for embedding models
              if (model.embedding && !capabilities.includes(ModelCapabilities.EMBEDDINGS)) {
                capabilities = [...capabilities, ModelCapabilities.EMBEDDINGS]
              }

              return {
                id: model.id,
                model: model.id,
                name: model.name,
                displayName: model.name,
                description: model.description,
                capabilities,
                embedding: model.embedding, // Preserve embedding flag for filtering in UI
                imported: (model as { imported?: boolean }).imported,
                template_kwargs: (model as { template_kwargs?: TemplateKwarg[] })
                  .template_kwargs,
                provider: providerName,
                settings: Object.values(modelSettings).reduce(
                  (acc, setting) => {
                    acc[setting.key] = {
                      ...setting,
                      controller_props: {
                        ...setting.controller_props,
                      },
                    }
                    return acc
                  },
                  {} as Record<string, ProviderSetting>
                ),
              } as Model
            })
          ),
        }
        runtimeProviders.push(provider)
      }

      return runtimeProviders.concat(builtinProviders as ModelProvider[])
    } catch (error: unknown) {
      console.error('Error getting providers in Tauri:', error)
      return []
    }
  }

  async deleteProviderKeys(providerName: string): Promise<void> {
    try {
      await invoke('delete_provider_keys', { provider: providerName })
    } catch (error) {
      console.error(`Failed to delete keyring keys for ${providerName}:`, error)
    }
  }

  async fetchModelsFromProvider(provider: ModelProvider): Promise<string[]> {
    if (!provider.base_url) {
      throw new Error('Provider must have base_url configured')
    }

    try {
      const keyChain = providerRemoteApiKeyChain(provider)
      const keyAttempts: (string | undefined)[] =
        keyChain.length > 0 ? keyChain : [undefined]

      let lastStatus = 0
      let lastStatusText = ''

      for (let ki = 0; ki < keyAttempts.length; ki++) {
        const key = keyAttempts[ki]
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        }

        if (
          provider.base_url.includes('localhost:') ||
          provider.base_url.includes('127.0.0.1:')
        ) {
          headers['Origin'] = 'tauri://localhost'
        }

        if (key) {
          headers['x-api-key'] = key
          headers['Authorization'] = `Bearer ${key}`
        }

        // After the key: reserved names are never applied, so a custom header
        // cannot replace it. janhq/jan#8208.
        applyCustomHeaders(headers, provider)

        ensureAnthropicHeaders(provider, headers)

        // The address as typed, then `/v1` when it carries no version of its
        // own and the first place answers 404.
        const candidates = modelsUrlCandidates(provider.base_url)
        let modelsUrl = candidates[0]
        let response = await fetchTauri(modelsUrl, {
          method: 'GET',
          headers,
        })
        if (response.status === 404 && candidates.length > 1) {
          modelsUrl = candidates[1]
          response = await fetchTauri(modelsUrl, { method: 'GET', headers })
        }

        lastStatus = response.status
        lastStatusText = response.statusText

        if (
          [401, 403, 429].includes(response.status) &&
          ki < keyAttempts.length - 1
        ) {
          continue
        }

        if (!response.ok) {
          // One message that names the provider, the endpoint, the status and
          // whoever answered. "Access forbidden: check your API key" was
          // actively misleading for a local server fronted by a proxy, where
          // the key was never the problem.
          throw new EndpointError(
            describeEndpointFailure({
              provider: provider.provider,
              url: modelsUrl,
              method: 'GET',
              status: response.status,
              statusText: response.statusText,
              server: response.headers?.get?.('server') ?? null,
            })
          )
        }

        const data = await response.json()

        // One parser for every shape. llama.cpp answers with a non-standard
        // `models` array whose entries carry `name`/`model` but no `id`, which
        // the previous branch turned into a list of `undefined`.
        const ids = parseModelList(Array.isArray(data) ? { data } : data)
        if (ids.length === 0) {
          console.warn('Provider listed no models at /models:', data)
        }
        return ids
      }

      throw new Error(
        `Failed to fetch models from ${provider.provider}: ${lastStatus} ${lastStatusText}`
      )
    } catch (error) {
      console.error('Error fetching models from provider:', error)

      // Already explained: the endpoint, the status and who answered. Wrapping
      // it would bury the only sentence that says what happened.
      if (isEndpointError(error)) throw error

      // Preserve structured error messages thrown above
      const structuredErrorPrefixes = [
        'Authentication failed',
        'Access forbidden',
        'Models endpoint not found',
        'Failed to fetch models from',
      ]

      if (
        error instanceof Error &&
        structuredErrorPrefixes.some((prefix) =>
          (error as Error).message.startsWith(prefix)
        )
      ) {
        throw new Error(error.message)
      }

      /**
       * Nothing answered.
       *
       * The transport already says what it tried and what it resolved to,
       * which is the whole diagnosis for a short hostname pointing at the
       * wrong machine. Both branches below used to bury that sentence: one
       * threw it away for a generic "Cannot connect", the other wrapped it in
       * "Unexpected error while fetching models from X", which reads as a
       * fault in Flint rather than an endpoint that is not listening.
       */
      throw new EndpointError(
        describeEndpointFailure({
          provider: provider.provider,
          url: `${provider.base_url}/models`,
          method: 'GET',
          cause: error,
        })
      )
    }
  }

  async updateSettings(
    providerName: string,
    settings: ProviderSetting[]
  ): Promise<void> {
    try {
      // API keys are persisted to the OS keyring only (via
      // register_provider_config), never to the extension's settings.json.
      // Blank the key entries at this single chokepoint regardless of caller.
      const isSecretKey = (key: string) =>
        key === 'api-key' || key === API_KEY_FALLBACKS_SETTING_KEY
      return ExtensionManager.getInstance()
        .getEngine(providerName)
        ?.updateSettings(
          settings.map((setting) => ({
            ...setting,
            controllerProps: {
              ...setting.controller_props,
              value: isSecretKey(setting.key)
                ? ''
                : setting.controller_props.value !== undefined
                  ? setting.controller_props.value
                  : '',
            },
            controllerType: setting.controller_type,
          })) as SettingComponentProps[]
        )
    } catch (error) {
      console.error('Error updating settings in Tauri:', error)
      throw error
    }
  }
}
