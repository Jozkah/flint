/**
 * Tauri Providers Service - Desktop implementation
 */

import { predefinedProviders } from '@/constants/providers'
import { invokeCommand } from '@/lib/backend'
import { providerModels } from '@/constants/models'
import { EngineManager, SettingComponentProps } from '@janhq/core'
import { ModelCapabilities } from '@/types/models'
import { modelSettings } from '@/lib/predefined'
import { ExtensionManager } from '@/lib/extension'
import { providerFetch as fetchTauri } from '@/lib/providerFetch'
import { DefaultProvidersService } from './default'
import { getModelCapabilities } from '@/lib/models'
import {
  API_KEY_FALLBACKS_SETTING_KEY,
  providerRemoteApiKeyChain,
} from '@/lib/provider-api-keys'
import {
  applyProviderAuthHeader,
  ensureAnthropicHeaders,
} from '@/lib/anthropicHeaders'
import { applyCustomHeaders } from '@/lib/customHeaders'
import {
  EndpointError,
  describeEndpointFailure,
  isEndpointError,
  parseModelList,
} from '@/lib/endpointDiagnostics'
import { modelsUrlCandidates } from '@/lib/modelsUrl'
import { buildProviderListRequest } from '@/lib/providerListRequest'
import { recordListedWindows } from '@/lib/listedWindows'
import { recordListedCapabilities } from '@/lib/listedCapabilities'
import { findModelEntry } from '@/lib/detectContextWindow'

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

      // Engines are listed side by side (HKS-034): one slow engine no longer
      // holds up the rest. Order is the engines' order, as before.
      const engines = [...EngineManager.instance().engines]
      const loaded = await Promise.allSettled(
        engines.map(async ([providerName, value]) => {
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
          return provider
        })
      )
      const runtimeProviders: ModelProvider[] = []
      loaded.forEach((result, i) => {
        if (result.status === 'fulfilled') runtimeProviders.push(result.value)
        // One failing engine must not empty the whole provider list
        // (janhq/jan#9376).
        else console.error(`Failed to load provider ${engines[i][0]}:`, result.reason)
      })

      return runtimeProviders.concat(builtinProviders as ModelProvider[])
    } catch (error: unknown) {
      console.error('Error getting providers in Tauri:', error)
      return []
    }
  }

  async deleteProviderKeys(providerName: string): Promise<void> {
    try {
      await invokeCommand('delete_provider_keys', { provider: providerName })
    } catch (error) {
      console.error(`Failed to delete keyring keys for ${providerName}:`, error)
    }
  }

  async fetchModelEntry(
    provider: ModelProvider,
    modelId: string
  ): Promise<Record<string, unknown> | null> {
    if (!provider.base_url) return null
    const keyChain = providerRemoteApiKeyChain(provider)
    const keyAttempts: (string | undefined)[] =
      keyChain.length > 0 ? keyChain : [undefined]
    for (const key of keyAttempts) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      applyProviderAuthHeader(provider, headers, key)
      applyCustomHeaders(headers, provider)
      ensureAnthropicHeaders(provider, headers)
      for (const url of modelsUrlCandidates(provider.base_url)) {
        let response: Response
        try {
          response = await fetchTauri(url, { method: 'GET', headers })
        } catch {
          // This address failed to connect; try the next one.
          continue
        }
        if (response.status === 404) continue
        if ([401, 402, 403, 429].includes(response.status)) break
        if (!response.ok) return null
        return findModelEntry(await response.json(), modelId)
      }
    }
    return null
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
        // Shared with the key test in Settings, so both authenticate the same
        // way (Azure `api-key` + `api-version`, Anthropic headers).
        const { headers, urls: candidates } = buildProviderListRequest(
          { ...provider, base_url: provider.base_url },
          key
        )
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
          [401, 402, 403, 429].includes(response.status) &&
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
        // Some catalogs list an id twice (Azure: one entry per version); the
        // id is the model's identity, so keep the first.
        const ids = [
          ...new Set(parseModelList(Array.isArray(data) ? { data } : data)),
        ]
        // The list carries each model's window (vLLM `max_model_len`); the ids
        // alone would throw it away.
        recordListedWindows(provider.base_url, data)
        // Tools and vision, where the provider's list says (OpenRouter does).
        recordListedCapabilities(provider.base_url, data)
        if (ids.length === 0) {
          console.warn('Provider listed no models at /models:', data)
        }
        return ids
      }

      throw new Error(
        `Failed to fetch models from ${provider.provider}: ${lastStatus} ${lastStatusText}`
      )
    } catch (error) {
      throw shapeListError(provider, error)
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

/**
 * The error a failed model listing rethrows: an endpoint error as is, a
 * structured message unwrapped, anything else described as the endpoint
 * not answering.
 */
function shapeListError(provider: ModelProvider, error: unknown): Error {
  console.error('Error fetching models from provider:', error)

  // Already explained: the endpoint, the status and who answered. Wrapping
  // it would bury the only sentence that says what happened.
  if (isEndpointError(error)) return error

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
    return new Error(error.message)
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
  return new EndpointError(
    describeEndpointFailure({
      provider: provider.provider,
      url: `${provider.base_url}/models`,
      method: 'GET',
      cause: error,
    })
  )
}
