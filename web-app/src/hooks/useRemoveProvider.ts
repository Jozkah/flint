import { useCallback } from 'react'
import { EngineManager } from '@janhq/core'
import { predefinedProviders } from '@/constants/providers'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { useServiceHub } from '@/hooks/useServiceHub'
import { deleteSecretHeaderValues } from '@/lib/providerHeaderSecrets'
import { isEngineProviderName } from '@/lib/engineModels'

/**
 * Whether the user added this provider (a custom OpenAI/Anthropic-compatible
 * endpoint, a LAN server, another local instance) and may remove it. Built-in
 * catalogue providers and the bundled engines (llama.cpp, MLX) are never
 * removed; they can only be turned off.
 */
export function isRemovableProvider(providerName: string): boolean {
  if (isEngineProviderName(providerName)) return false
  if (predefinedProviders.some((e) => e.provider === providerName)) return false
  try {
    if (EngineManager.instance().get(providerName)) return false
  } catch {
    // No engine registry (tests, web build): only the catalogue check applies.
  }
  return true
}

export type ProviderMenuAction = 'edit' | 'rename' | 'toggle' | 'remove'

/** The actions a provider card offers, by who added the provider. */
export function providerMenuActions(providerName: string): ProviderMenuAction[] {
  return isRemovableProvider(providerName)
    ? ['edit', 'rename', 'toggle', 'remove']
    : ['edit', 'rename', 'toggle']
}

/**
 * Removes a provider the user added, together with everything stored for it:
 * favourites pointing at its models, its API key secret in the OS keyring,
 * its secret custom header values, and a model selection pointing at it.
 * Chats, sessions, rooms and assistants keep their history; the model they
 * used shows as unavailable.
 */
export function useRemoveProvider() {
  const deleteProvider = useModelProvider((s) => s.deleteProvider)
  const serviceHub = useServiceHub()
  const favoriteModels = useFavoriteModel((s) => s.favoriteModels)
  const removeFavorite = useFavoriteModel((s) => s.removeFavorite)

  return useCallback(
    async (provider: ProviderObject) => {
      const ids = new Set(provider.models.map((m) => m.id))
      favoriteModels.forEach((f) => {
        if (ids.has(f.id)) removeFavorite(f.id, provider.provider)
      })
      // deleteProvider also clears a selection pointing at this provider.
      deleteProvider(provider.provider)
      await Promise.allSettled([
        Promise.resolve().then(() =>
          serviceHub.providers().deleteProviderKeys(provider.provider)
        ),
        deleteSecretHeaderValues(provider.provider),
      ])
    },
    [deleteProvider, serviceHub, favoriteModels, removeFavorite]
  )
}
