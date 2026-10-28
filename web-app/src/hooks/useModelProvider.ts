import { syncProviderDisplayNames } from '@/lib/providerDisplayNames'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { getServiceHub } from '@/hooks/useServiceHub'
import { backendStorage } from '@/lib/backendStorage'
import { modelSettings } from '@/lib/predefined'
import { usableContextValue } from '@/lib/modelCapabilities'
import { forgetAllServerLimits } from '@/lib/contextLimitRecovery'
import {
  AZURE_BASE_URL_PLACEHOLDER,
  predefinedProviders,
} from '@/constants/providers'
import { isLocalProvider } from '@/lib/utils'
import { API_KEY_FALLBACKS_SETTING_KEY } from '@/lib/provider-api-keys'
import { withoutSecretValues } from '@/lib/customHeaders'
import {
  originOf,
  useProviderReachability,
} from '@/hooks/useProviderReachability'

const API_KEY_SETTING_KEY = 'api-key'

// Secrets live only in the OS keyring (see register_provider_config), never in
// persisted settings storage. Strip the key chain from every provider before it
// is written to disk; the in-memory object keeps the keys (re-seeded from the
// keyring at boot in DataProvider) so synchronous consumers still work.
export function stripProviderSecrets(provider: ModelProvider): ModelProvider {
  const settings = provider.settings?.map((s) =>
    s.key === API_KEY_SETTING_KEY || s.key === API_KEY_FALLBACKS_SETTING_KEY
      ? { ...s, controller_props: { ...s.controller_props, value: '' } }
      : s
  )
  return {
    ...provider,
    api_key: undefined,
    api_key_fallbacks: undefined,
    ...(settings ? { settings } : {}),
    // A custom header marked secret is a credential too. janhq/jan#8208.
    ...(provider.custom_header
      ? { custom_header: withoutSecretValues(provider.custom_header) }
      : {}),
  }
}

// A model's id is its identity within a provider: lookups find by id and the
// model lists key rows on it. Keep the first occurrence (carries user edits).
function uniqueModelsById(models: Model[]): Model[] {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

// Strings are legacy global tombstones (persisted before provider-scoped
// records, with no way to tell their owner); new deletions always carry the
// provider that owned the model (janhq/jan#9336).
type DeletedModel = string | { provider: string; id: string }

function isDeleted(entry: DeletedModel, provider: string, id: string): boolean {
  return typeof entry === 'string'
    ? entry === id
    : entry.provider === provider && entry.id === id
}

type ModelProviderState = {
  providers: ModelProvider[]
  selectedProvider: string
  selectedModel: Model | null
  deletedModels: DeletedModel[]
  getModelBy: (modelId: string) => Model | undefined
  setProviders: (providers: ModelProvider[]) => void
  getProviderByName: (providerName: string) => ModelProvider | undefined
  updateProvider: (providerName: string, data: Partial<ModelProvider>) => void
  selectModelProvider: (
    providerName: string,
    modelName: string
  ) => Model | undefined
  addProvider: (provider: ModelProvider) => void
  deleteProvider: (providerName: string) => void
  deleteModel: (modelId: string, provider: string) => void
  addDeletedModels: (modelIds: string[], provider: string) => void
}

// Order matters (fallbacks are tried in sequence); undefined equals empty.
const sameKeyList = (a?: string[], b?: string[]): boolean => {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((key, i) => key === y[i])
}

export const useModelProvider = create<ModelProviderState>()(
  persist(
    (set, get) => ({
      providers: [],
      selectedProvider: 'llamacpp',
      selectedModel: null,
      deletedModels: [],
      getModelBy: (modelId: string) => {
        const provider = get().providers.find(
          (provider) => provider.provider === get().selectedProvider
        )
        if (!provider) return undefined
        return provider.models.find((model) => model.id === modelId)
      },
      setProviders: (providers) =>
        set((state) => {
          // MLX is Apple-Silicon only; drop it on every other platform so it
          // can't be reactivated, queried, or shown anywhere in the UI.
          providers = IS_MACOS
            ? providers
            : providers.filter((e) => e.provider !== 'mlx')
          const existingProviders = state.providers
            .filter((e) => IS_MACOS || e.provider !== 'mlx')
            // Filter out legacy llama.cpp provider for migration
            // Can remove after a couple of releases
            .filter((e) => e.provider !== 'llama.cpp')
            .map((provider) => {
              return {
                ...provider,
                models: provider.models.filter(
                  (e) =>
                    ('id' in e || 'model' in e) &&
                    typeof (e.id ?? e.model) === 'string'
                ),
              }
            })

          let legacyModels: Model[] | undefined = []
          /// Cortex Migration
          if (
            localStorage.getItem('cortex_model_settings_migrated') !== 'true'
          ) {
            legacyModels = state.providers.find(
              (e) => e.provider === 'llama.cpp'
            )?.models
            localStorage.setItem('cortex_model_settings_migrated', 'true')
          }
          // Ensure deletedModels is always an array
          const currentDeletedModels = Array.isArray(state.deletedModels)
            ? state.deletedModels
            : []

          // For local providers (llamacpp, mlx) the engine's list() is the
          // source of truth: a model only appears here if it is on disk. If
          // an id was previously soft-deleted but reappears in a fresh local
          // listing, the user has re-downloaded/re-imported it and the
          // tombstone must be cleared — otherwise the merge below filters it
          // out forever.
          const locallyPresentIds = new Set<string>()
          const locallyPresentModels = new Set<string>()
          for (const p of providers) {
            if (!isLocalProvider(p.provider)) continue
            for (const m of p.models ?? []) {
              if (m?.id) {
                locallyPresentIds.add(m.id)
                locallyPresentModels.add(JSON.stringify([p.provider, m.id]))
              }
            }
          }
          const effectiveDeletedModels =
            locallyPresentIds.size === 0
              ? currentDeletedModels
              : currentDeletedModels.filter((entry) =>
                  typeof entry === 'string'
                    ? !locallyPresentIds.has(entry)
                    : !locallyPresentModels.has(
                        JSON.stringify([entry.provider, entry.id])
                      )
                )

          const updatedProviders = providers.map((provider) => {
            const existingProvider = existingProviders.find(
              (x) => x.provider === provider.provider
            )
            const models = (existingProvider?.models || []).filter(
              (e) =>
                ('id' in e || 'model' in e) &&
                typeof (e.id ?? e.model) === 'string'
            )
            const mergedModels = [
              ...(provider?.models ?? []).filter(
                (e) =>
                  ('id' in e || 'model' in e) &&
                  typeof (e.id ?? e.model) === 'string' &&
                  !models.some((m) => m.id === e.id) &&
                  !effectiveDeletedModels.some((entry) =>
                    isDeleted(entry, provider.provider, e.id)
                  )
              ),
              ...models,
            ]
            const updatedModels = provider.models?.map((model) => {
              const settings =
                (legacyModels && legacyModels?.length > 0
                  ? legacyModels
                  : models
                ).find(
                  (m) =>
                    m.id
                      .split(':')
                      .slice(0, 2)
                      .join(getServiceHub().path().sep()) === model.id
                )?.settings || model.settings
              const existingModel = models.find((m) => m.id === model.id)
              const userConfiguredCapabilities =
                (
                  existingModel as Model & {
                    _userConfiguredCapabilities?: boolean
                  }
                )?._userConfiguredCapabilities === true

              const engineOwnedCaps = new Set(['vision', 'audio', 'embeddings'])
              const engineCaps = model.capabilities || []
              const existingCaps = existingModel?.capabilities || []
              const mergedCapabilities = userConfiguredCapabilities
                ? [
                    ...existingCaps.filter((c) => !engineOwnedCaps.has(c)),
                    ...engineCaps.filter((c) => engineOwnedCaps.has(c)),
                  ]
                : [
                    ...engineCaps,
                    ...existingCaps.filter((c) => !engineCaps.includes(c)),
                  ]
              return {
                ...model,
                settings: settings,
                capabilities:
                  mergedCapabilities.length > 0 ? mergedCapabilities : undefined,
                displayName: existingModel?.displayName || model.displayName,
                ...(userConfiguredCapabilities
                  ? { _userConfiguredCapabilities: true as const }
                  : {}),
              }
            })

            const mergedSettings = provider.settings.map((setting) => {
              const existingSetting = provider.persist
                ? undefined
                : existingProvider?.settings?.find(
                    (x) => x.key === setting.key
                  )
              // Only the user's `value` is carried over from existing state;
              // metadata like `recommended` / `options` must always reflect
              // the fresh extension fetch (otherwise stale recommendations
              // and stale option lists outlive the underlying setting).
              const existingValue = (
                existingSetting?.controller_props as
                  | { value?: string | number | boolean }
                  | undefined
              )?.value
              return {
                ...setting,
                controller_props: {
                  ...setting.controller_props,
                  ...(existingSetting && existingValue !== undefined
                    ? { value: existingValue }
                    : {}),
                },
              }
            })

            // API keys live only in the OS keyring, never in provider settings.
            // The in-memory chain is preserved from existing state or the
            // keyring-seeded incoming provider (DataProvider).
            return {
              ...provider,
              models: uniqueModelsById(
                provider.persist ? updatedModels : mergedModels
              ),
              settings: mergedSettings,
              api_key: existingProvider?.api_key || provider.api_key,
              api_key_fallbacks:
                existingProvider?.api_key_fallbacks ?? provider.api_key_fallbacks,
              base_url: existingProvider?.base_url || provider.base_url,
              // A first install starts with none of the built-in cloud providers
              // switched on; the local engine and providers the user adds are.
              active: existingProvider
                ? existingProvider?.active
                : !predefinedProviders.some((p) => p.provider === provider.provider),
              displayName: existingProvider?.displayName ?? provider.displayName,
            }
          })
          const nextProviders = [
            ...updatedProviders,
            ...existingProviders.filter(
              (e) => !updatedProviders.some((p) => p.provider === e.provider)
            ),
          ]

          return effectiveDeletedModels === currentDeletedModels
            ? { providers: nextProviders }
            : {
                providers: nextProviders,
                deletedModels: effectiveDeletedModels,
              }
        }),
      updateProvider: (providerName, data) => {
        // Reconfiguring a provider makes past failures meaningless: a new base
        // URL or key is a different endpoint, and the old verdict would just
        // be an accusation carried forward.
        // Callers often spread the whole provider back in, so a key being
        // present is not a change: compare against what is stored.
        const previous = get().providers.find(
          (p) => p.provider === providerName
        )
        const urlChanged =
          'base_url' in data && data.base_url !== previous?.base_url
        const keyChanged =
          'api_key' in data && data.api_key !== previous?.api_key
        const fallbacksChanged =
          'api_key_fallbacks' in data &&
          !sameKeyList(data.api_key_fallbacks, previous?.api_key_fallbacks)
        if (urlChanged || keyChanged || fallbacksChanged) {
          // A context window learned from the old endpoint's own refusal would
          // be enforced silently against the new one. Forgetting returns it to
          // unknown, which still dispatches; a stale limit does not.
          forgetAllServerLimits()
          for (const url of [previous?.base_url, data.base_url]) {
            const origin = originOf(url)
            if (origin) useProviderReachability.getState().forgetOrigin(origin)
          }
        }
        set((state) => {
          const providers = state.providers.map((provider) => {
            if (provider.provider === providerName) {
              return {
                ...provider,
                ...data,
                ...(Array.isArray(data.models)
                  ? { models: uniqueModelsById(data.models) }
                  : {}),
              }
            }
            return provider
          })

          let selectedModel = state.selectedModel
          if (
            selectedModel &&
            state.selectedProvider === providerName &&
            Array.isArray(data.models)
          ) {
            selectedModel =
              data.models.find((model) => model.id === selectedModel?.id) ?? null
          }

          return {
            providers,
            selectedModel,
          }
        })
      },
      getProviderByName: (providerName: string) => {
        const provider = get().providers.find(
          (provider) => provider.provider === providerName
        )

        return provider
      },
      selectModelProvider: (providerName: string, modelName: string) => {
        // Find the model object
        const provider = get().providers.find(
          (provider) => provider.provider === providerName
        )

        let modelObject: Model | undefined = undefined

        if (provider && provider.models) {
          modelObject = provider.models.find((model) => model.id === modelName)
        }

        // Update state with provider name and model object
        set({
          selectedProvider: providerName,
          selectedModel: modelObject || null,
        })

        return modelObject
      },
      deleteModel: (modelId: string, providerName: string) => {
        set((state) => {
          // Ensure deletedModels is always an array
          const currentDeletedModels = Array.isArray(state.deletedModels)
            ? state.deletedModels
            : []

          return {
            providers: state.providers.map((provider) => {
              if (provider.provider !== providerName) return provider
              const models = provider.models.filter(
                (model) => model.id !== modelId
              )
              return {
                ...provider,
                models,
              }
            }),
            deletedModels: currentDeletedModels.some(
              (entry) =>
                typeof entry !== 'string' &&
                isDeleted(entry, providerName, modelId)
            )
              ? currentDeletedModels
              : [...currentDeletedModels, { provider: providerName, id: modelId }],
            selectedModel:
              state.selectedProvider === providerName &&
              state.selectedModel?.id === modelId
                ? null
                : state.selectedModel,
          }
        })
      },
      addDeletedModels: (modelIds: string[], provider: string) => {
        if (modelIds.length === 0) return
        set((state) => {
          const current = Array.isArray(state.deletedModels)
            ? state.deletedModels
            : []
          const next = [...current]
          for (const id of modelIds) {
            if (
              !next.some(
                (entry) =>
                  typeof entry !== 'string' && isDeleted(entry, provider, id)
              )
            ) {
              next.push({ provider, id })
            }
          }
          if (next.length === current.length) return state
          return { deletedModels: next }
        })
      },
      addProvider: (provider: ModelProvider) => {
        set((state) => ({
          providers: [...state.providers, provider],
        }))
      },
      deleteProvider: (providerName: string) => {
        set((state) => ({
          providers: state.providers.filter(
            (provider) => provider.provider !== providerName
          ),
          // A selection pointing at the removed provider would name a model
          // that no longer exists; fall back to the default local engine.
          ...(state.selectedProvider === providerName
            ? { selectedProvider: 'llamacpp', selectedModel: null }
            : {}),
        }))
      },
    }),
    {
      name: localStorageKey.modelProvider,
      storage: createJSONStorage(() => backendStorage),
      // Async backend storage; hydrate explicitly after ServiceHub init.
      skipHydration: true,
      // Never persist API keys — they live in the OS keyring only.
      partialize: (state) => ({
        ...state,
        providers: state.providers.map(stripProviderSecrets),
      }),
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as ModelProviderState & {
          providers: Array<
            ModelProvider & {
              models: Array<
                Model & {
                  settings?: Record<string, unknown> & {
                    chatTemplate?: string
                    chat_template?: string
                  }
                }
              >
            }
          >
        }

        if (version <= 1 && state?.providers) {
          state.providers.forEach((provider) => {
            // Update cont_batching description for llamacpp provider
            if (provider.provider === 'llamacpp' && provider.settings) {
              const contBatchingSetting = provider.settings.find(
                (s) => s.key === 'cont_batching'
              )
              if (contBatchingSetting) {
                contBatchingSetting.description =
                  'Enable continuous batching (a.k.a dynamic batching) for concurrent requests.'
              }
            }

            // Migrate model settings
            if (provider.models && provider.provider === 'llamacpp') {
              provider.models.forEach((model) => {
                if (!model.settings) model.settings = {}

                // Migrate chatTemplate key to chat_template
                if (model.settings.chatTemplate) {
                  model.settings.chat_template = model.settings.chatTemplate
                  delete model.settings.chatTemplate
                }

                // Add missing settings with defaults
                if (!model.settings.chat_template) {
                  model.settings.chat_template = {
                    ...modelSettings.chatTemplate,
                    controller_props: {
                      ...modelSettings.chatTemplate.controller_props,
                    },
                  }
                }

                if (!model.settings.override_tensor_buffer_t) {
                  model.settings.override_tensor_buffer_t = {
                    ...modelSettings.override_tensor_buffer_t,
                    controller_props: {
                      ...modelSettings.override_tensor_buffer_t
                        .controller_props,
                    },
                  }
                }

                if (!model.settings.no_kv_offload) {
                  model.settings.no_kv_offload = {
                    ...modelSettings.no_kv_offload,
                    controller_props: {
                      ...modelSettings.no_kv_offload.controller_props,
                    },
                  }
                }
              })
            }
          })
        }

        if (version <= 2 && state?.providers) {
          state.providers.forEach((provider) => {
            // Update cont_batching description for llamacpp provider
            if (provider.provider === 'llamacpp' && provider.settings) {
              const contBatchingSetting = provider.settings.find(
                (s) => s.key === 'cont_batching'
              )
              if (contBatchingSetting) {
                contBatchingSetting.description =
                  'Enable continuous batching (a.k.a dynamic batching) for concurrent requests.'
              }
            }

            // Migrate model settings
            if (provider.models && provider.provider === 'llamacpp') {
              provider.models.forEach((model) => {
                if (!model.settings) model.settings = {}

                if (!model.settings.batch_size) {
                  model.settings.batch_size = {
                    ...modelSettings.batch_size,
                    controller_props: {
                      ...modelSettings.batch_size.controller_props,
                    },
                  }
                }
              })
            }
          })
        }

        if (version <= 3 && state?.providers) {
          state.providers.forEach((provider) => {
            // Migrate Anthropic provider base URL and add custom headers
            if (provider.provider === 'anthropic') {
              if (provider.base_url === 'https://api.anthropic.com') {
                provider.base_url = 'https://api.anthropic.com/v1'
              }

              // Update base-url in settings
              if (provider.settings) {
                const baseUrlSetting = provider.settings.find(
                  (s) => s.key === 'base-url'
                )
                if (
                  baseUrlSetting?.controller_props?.value ===
                  'https://api.anthropic.com'
                ) {
                  baseUrlSetting.controller_props.value =
                    'https://api.anthropic.com/v1'
                }
                if (
                  baseUrlSetting?.controller_props?.placeholder ===
                  'https://api.anthropic.com'
                ) {
                  baseUrlSetting.controller_props.placeholder =
                    'https://api.anthropic.com/v1'
                }
              }

              if (!provider.custom_header) {
                provider.custom_header = [
                  {
                    header: 'anthropic-version',
                    value: '2023-06-01',
                  },
                  {
                    header: 'anthropic-dangerous-direct-browser-access',
                    value: 'true',
                  },
                ]
              }
            }

            if (provider.provider === 'cohere') {
              if (
                provider.base_url === 'https://api.cohere.ai/compatibility/v1'
              ) {
                provider.base_url = 'https://api.cohere.ai/v1'
              }

              // Update base-url in settings
              if (provider.settings) {
                const baseUrlSetting = provider.settings.find(
                  (s) => s.key === 'base-url'
                )
                if (
                  baseUrlSetting?.controller_props?.value ===
                  'https://api.cohere.ai/compatibility/v1'
                ) {
                  baseUrlSetting.controller_props.value =
                    'https://api.cohere.ai/v1'
                }
                if (
                  baseUrlSetting?.controller_props?.placeholder ===
                  'https://api.cohere.ai/compatibility/v1'
                ) {
                  baseUrlSetting.controller_props.placeholder =
                    'https://api.cohere.ai/v1'
                }
              }
            }
          })
        }

        if (version <= 4 && state?.providers) {
          state.providers.forEach((provider) => {
            // Migrate model settings
            if (provider.models && provider.provider === 'llamacpp') {
              provider.models.forEach((model) => {
                if (!model.settings) model.settings = {}

                if (!model.settings.cpu_moe) {
                  model.settings.cpu_moe = {
                    ...modelSettings.cpu_moe,
                    controller_props: {
                      ...modelSettings.cpu_moe.controller_props,
                    },
                  }
                }

                if (!model.settings.n_cpu_moe) {
                  model.settings.n_cpu_moe = {
                    ...modelSettings.n_cpu_moe,
                    controller_props: {
                      ...modelSettings.n_cpu_moe.controller_props,
                    },
                  }
                }
              })
            }
          })
        }
        if (version <= 5 && state?.providers) {
          state.providers.forEach((provider) => {
            // Migrate flash_attn setting to dropdown for llamacpp provider
            if (provider.provider === 'llamacpp' && provider.settings) {
              const flashAttentionSetting = provider.settings.find(
                (s) => s.key === 'flash_attn'
              )
              if (flashAttentionSetting) {
                flashAttentionSetting.controller_type = 'dropdown'
                flashAttentionSetting.controller_props = {
                  ...flashAttentionSetting.controller_props,
                  options: [
                    { name: 'Auto', value: 'auto' },
                    { name: 'On', value: 'on' },
                    { name: 'Off', value: 'off' },
                  ],
                  value: 'auto',
                }
              }
            }
          })
        }
        if (version <= 7 && state?.providers) {
          // Remove 'proactive' capability from all models as it's now managed in MCP settings
          state.providers.forEach((provider) => {
            if (provider.models) {
              provider.models.forEach((model) => {
                if (model.capabilities) {
                  model.capabilities = model.capabilities.filter(
                    (cap) => cap !== 'proactive'
                  )
                }
              })
            }
          })
        }
        if (version <= 8 && state?.providers) {
          state.providers.forEach((provider) => {
            // Migrate Mistral provider base URL to add /v1
            if (provider.provider === 'mistral') {
              if (provider.base_url === 'https://api.mistral.ai') {
                provider.base_url = 'https://api.mistral.ai/v1'
              }

              // Update base-url in settings
              if (provider.settings) {
                const baseUrlSetting = provider.settings.find(
                  (s) => s.key === 'base-url'
                )
                if (
                  baseUrlSetting?.controller_props?.value ===
                  'https://api.mistral.ai'
                ) {
                  baseUrlSetting.controller_props.value =
                    'https://api.mistral.ai/v1'
                }
                if (
                  baseUrlSetting?.controller_props?.placeholder ===
                  'https://api.mistral.ai'
                ) {
                  baseUrlSetting.controller_props.placeholder =
                    'https://api.mistral.ai/v1'
                }
              }
            }
          })
        }

        if (version <= 9 && state?.providers) {
          state.providers = state.providers.filter(
            (provider) => provider.provider !== 'cohere'
          )
        }

        // Migration v10 historically inserted `auto_increase_ctx_len`. The
        // setting was removed in v15, so v10 is now a no-op for any user
        // still passing through this point.

        if (version <= 11 && state?.providers) {
          state.providers.forEach((provider) => {
            if (provider.provider !== 'llamacpp') return

            // Reasoning moved from extension-level to per-model settings —
            // strip any stale entry from the provider settings panel.
            if (provider.settings) {
              provider.settings = provider.settings.filter(
                (s) => s.key !== 'reasoning'
              )
            }

            if (provider.models) {
              provider.models.forEach((model) => {
                if (!model.settings) model.settings = {}

                if (!model.settings.reasoning) {
                  model.settings.reasoning = {
                    ...modelSettings.reasoning,
                    controller_props: {
                      ...modelSettings.reasoning.controller_props,
                    },
                  }
                }
              })
            }
          })
        }

        if (version <= 13 && state?.providers) {
          // Predefined providers no longer carry a user-editable base-url
          // setting. Force their base_url back to the canonical constant and
          // strip any leftover base-url entry from persisted settings[].
          const canonicalByName = new Map(
            predefinedProviders.map((p) => [p.provider, p.base_url])
          )
          state.providers.forEach((provider) => {
            const canonical = canonicalByName.get(provider.provider)
            if (!canonical) return
            provider.base_url = canonical
            if (provider.settings) {
              provider.settings = provider.settings.filter(
                (s) => s.key !== 'base-url'
              )
            }
          })
        }

        if (version <= 12 && state?.providers) {
          // Reset ctx_len from the prior 8192 default to '' so llama.cpp picks
          // (auto-fit when enabled, model default otherwise). Preserve any
          // user-customised value.
          state.providers.forEach((provider) => {
            if (provider.provider !== 'llamacpp' || !provider.models) return
            provider.models.forEach((model) => {
              const ctx = model.settings?.ctx_len as
                | { controller_props?: { value?: unknown } }
                | undefined
              const controllerProps = ctx?.controller_props
              const ctxValue =
                typeof controllerProps?.value === 'string'
                  ? Number(controllerProps.value)
                  : controllerProps?.value
              if (ctxValue === 8192 && controllerProps) {
                controllerProps.value = ''
              }
            })
          })
        }

        if (version <= 13 && state?.providers) {
          // `defrag-thold` was deprecated upstream and the control was deleted
          // from settings.json. Strip the orphan entry from the persisted
          // provider settings array so localStorage doesn't carry it forever.
          state.providers.forEach((provider) => {
            if (provider.provider !== 'llamacpp' || !provider.settings) return
            provider.settings = provider.settings.filter(
              (s) => s.key !== 'defrag_thold'
            )
          })
        }

        if (version <= 14 && state?.providers) {
          // Auto-increase context was removed — the manual "Increase Context
          // Size" button in the error banner now owns this. Strip the per-model
          // setting entry from llamacpp models so the sidebar doesn't render a
          // dead control.
          state.providers.forEach((provider) => {
            if (provider.provider !== 'llamacpp' || !provider.models) return
            provider.models.forEach((model) => {
              if (model.settings?.auto_increase_ctx_len) {
                delete (model.settings as Record<string, unknown>)
                  .auto_increase_ctx_len
              }
            })
          })
        }
        if (version <= 15 && state?.providers) {
          // Introduce `api_type` discriminant. Backfill on the built-in
          // Anthropic provider; everything else stays undefined (defaults to
          // 'openai' at dispatch time).
          state.providers.forEach((provider) => {
            if (provider.provider === 'anthropic' && !provider.api_type) {
              provider.api_type = 'anthropic'
            }
          })
        }

        if (version <= 16 && state?.providers) {
          // Auto-fit is now disabled by default, so seed empty/auto ctx_len
          // with the new 8192 default. Preserve any user-customised value.
          state.providers.forEach((provider) => {
            if (provider.provider !== 'llamacpp' || !provider.models) return
            provider.models.forEach((model) => {
              const ctx = model.settings?.ctx_len as
                | { controller_props?: { value?: unknown } }
                | undefined
              const controllerProps = ctx?.controller_props
              if (!controllerProps) return
              const value = controllerProps.value
              if (value === '' || value == null) {
                controllerProps.value = 8192
              }
            })
          })
        }

        if (version <= 17 && state?.providers) {
          // Grammar became a per-model setting; add the control to persisted
          // llamacpp models so the sidebar renders it.
          state.providers.forEach((provider) => {
            if (provider.provider !== 'llamacpp' || !provider.models) return
            provider.models.forEach((model) => {
              if (!model.settings) model.settings = {}
              if (!model.settings.grammar) {
                model.settings.grammar = {
                  ...modelSettings.grammar,
                  controller_props: {
                    ...modelSettings.grammar.controller_props,
                  },
                }
              }
            })
          })
        }

        if (version <= 18 && state?.providers) {
          // A persisted context size of 0 is not a context size.
          //
          // It reached settings from a provider that reported `"context_length":
          // 0`, from a control saved while empty, and from a `parseInt` of a
          // malformed string. Downstream it was read as a real capacity: the
          // indicator drew `0 / 0`, the budget had no room for a single token,
          // and the request carried a reply cap of zero. Every such value
          // becomes "not set" here, which is the state the rest of the app
          // already knows how to resolve -- discovery runs, and an undiscovered
          // window stays explicitly unknown rather than pretending to be empty.
          //
          // A positive value is a decision the user or a provider made and is
          // never touched. Nothing else in the model's settings is altered, so
          // a profile does not have to be deleted to get out of this state.
          let repaired = 0
          state.providers.forEach((provider) => {
            provider.models?.forEach((model) => {
              const controllerProps = (
                model.settings?.ctx_len as
                  | { controller_props?: { value?: unknown } }
                  | undefined
              )?.controller_props
              if (!controllerProps) return
              const value = controllerProps.value
              // An empty control is already "not set"; leave it alone so this
              // does not churn every model on every upgrade.
              if (value === '' || value == null) return
              if (usableContextValue(value) == null) {
                controllerProps.value = ''
                repaired += 1
              }
            })
          })
          if (repaired > 0) {
            // Counted, not itemised: the number is the useful fact, and a
            // provider entry carries its API key.
            console.info(
              `[jan] migrated ${repaired} model(s) whose stored context size was not a usable number`
            )
          }
        }

        if (version <= 19 && state?.providers) {
          // llama.cpp 0.4.0 added --n-cpu-ffn, the dense counterpart of
          // --n-cpu-moe; add the control to persisted llamacpp models so the
          // sidebar renders it.
          state.providers.forEach((provider) => {
            if (provider.provider !== 'llamacpp' || !provider.models) return
            provider.models.forEach((model) => {
              if (!model.settings) model.settings = {}
              if (!model.settings.n_cpu_ffn) {
                model.settings.n_cpu_ffn = {
                  ...modelSettings.n_cpu_ffn,
                  controller_props: {
                    ...modelSettings.n_cpu_ffn.controller_props,
                  },
                }
              }
            })
          })
        }

        if (version <= 20 && state?.providers) {
          // Per-model reasoning default, stop strings and extra llama-server
          // arguments: add the controls to persisted llamacpp models.
          state.providers.forEach((provider) => {
            if (provider.provider !== 'llamacpp' || !provider.models) return
            provider.models.forEach((model) => {
              if (!model.settings) model.settings = {}
              for (const key of [
                'server_reasoning',
                'stop_strings',
                'model_extra_args',
              ] as const) {
                if (!model.settings[key]) {
                  model.settings[key] = {
                    ...modelSettings[key],
                    controller_props: { ...modelSettings[key].controller_props },
                  }
                }
              }
            })
          })
        }

        if (version <= 21 && state?.providers) {
          // Azure used to ship its example endpoint as the default base_url, so
          // an unconfigured install sent requests (and any key entered) to
          // `your-resource-name`, a resource name anyone can register. Treat
          // that stored example as "not configured". janhq/jan#9210.
          state.providers.forEach((provider) => {
            if (provider.provider !== 'azure') return
            if (provider.base_url === AZURE_BASE_URL_PLACEHOLDER) {
              provider.base_url = ''
            }
            const props = provider.settings?.find((s) => s.key === 'base-url')
              ?.controller_props as { value?: unknown } | undefined
            if (props?.value === AZURE_BASE_URL_PLACEHOLDER) props.value = ''
          })
        }

        if (version <= 22 && state?.providers) {
          // Per-model Context Shift and KV cache types: add the controls to
          // persisted llamacpp models. They default to "use global".
          state.providers.forEach((provider) => {
            if (provider.provider !== 'llamacpp' || !provider.models) return
            provider.models.forEach((model) => {
              if (!model.settings) model.settings = {}
              for (const key of [
                'ctx_shift',
                'seed',
                'cache_type_k',
                'cache_type_v',
              ] as const) {
                if (!model.settings[key]) {
                  model.settings[key] = {
                    ...modelSettings[key],
                    controller_props: { ...modelSettings[key].controller_props },
                  }
                }
              }
            })
          })
        }

        if (version <= 23 && state?.providers) {
          // The provider's Default context size only applies to models that
          // set none of their own, but every model was seeded with 8192, so it
          // never applied (C043). Clear the seeded value; keep any other.
          state.providers.forEach((provider) => {
            if (provider.provider !== 'llamacpp' || !provider.models) return
            provider.models.forEach((model) => {
              const props = (
                model.settings?.ctx_len as
                  | { controller_props?: { value?: unknown } }
                  | undefined
              )?.controller_props
              if (props && Number(props.value) === 8192) props.value = ''
            })
          })
        }

        if (version <= 24 && state) {
          // Deletion records are provider-scoped from here on. Old string
          // entries cannot be attributed to a provider, so they stay as global
          // records; anything that is neither a string nor a scoped record is
          // dropped.
          state.deletedModels = (
            Array.isArray(state.deletedModels) ? state.deletedModels : []
          ).filter(
            (entry) =>
              typeof entry === 'string' ||
              (!!entry &&
                typeof entry.provider === 'string' &&
                typeof entry.id === 'string')
          )
        }

        return state
      },
      version: 25,
    }
  )
)

// Keep provider titles (getProviderTitle) in step with user renames.
syncProviderDisplayNames(useModelProvider.getState().providers)
useModelProvider.subscribe((state, prev) => {
  if (state.providers !== prev.providers) syncProviderDisplayNames(state.providers)
})
