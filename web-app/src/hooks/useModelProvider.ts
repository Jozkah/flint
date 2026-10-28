import { syncProviderDisplayNames } from '@/lib/providerDisplayNames'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { getServiceHub } from '@/hooks/useServiceHub'
import { backendStorage } from '@/lib/backendStorage'
import { forgetAllServerLimits } from '@/lib/contextLimitRecovery'
import { predefinedProviders } from '@/constants/providers'
import { isLocalProvider } from '@/lib/utils'
import {
  isDeleted,
  stripProviderSecrets,
  uniqueModelsById,
  type ModelProviderState,
} from '@/lib/providerState'
import { migrateProviderState } from '@/lib/providerMigrations'
import {
  originOf,
  useProviderReachability,
} from '@/hooks/useProviderReachability'

// Re-exported: other modules and tests import it from here.
export { stripProviderSecrets }

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
      getModelBy: (modelId: string, providerName?: string) => {
        const wanted = providerName ?? get().selectedProvider
        const provider = get().providers.find(
          (provider) => provider.provider === wanted
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
      migrate: migrateProviderState,
      version: 25,
    }
  )
)

// Keep provider titles (getProviderTitle) in step with user renames.
syncProviderDisplayNames(useModelProvider.getState().providers)
useModelProvider.subscribe((state, prev) => {
  if (state.providers !== prev.providers) syncProviderDisplayNames(state.providers)
})
