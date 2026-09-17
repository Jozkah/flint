import { predefinedProviders } from '@/constants/providers'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'

/**
 * Whether a provider name matches a bundled built-in template.
 *
 * An exact match, not a substring test: asking whether a template's id contains
 * the user's provider name let a provider called `ai` match `openai` and one
 * called `x` match `xai`, silently reclassifying a user's provider as built-in.
 */
export function isPredefinedProvider(providerName: string): boolean {
  return predefinedProviders.some((e) => e.provider === providerName)
}

/**
 * Should this provider's models be offered in a model picker?
 *
 * The single rule every model picker shares — the Home/Cowork bar and the Rooms
 * participant picker — so they all offer the same providers.
 *
 * The rule that matters: a provider the user configured, which has models, is
 * always offered. Only an *unconfigured built-in template* is hidden, and that
 * is what the API-key check is for -- it is a proxy for "the user has not set
 * this one up", never a gate on providers they plainly did set up.
 *
 * Keying that gate on `api_key` alone is what made models vanish from the bar
 * after a restart: `partialize` strips `api_key`/`api_key_fallbacks` before
 * persisting -- keys live in the OS keyring -- so on every launch every provider
 * looks keyless until `applyKeyringKeys()` re-seeds them.
 */
export function offersModels(provider: {
  provider: string
  models: unknown[]
  api_key?: string
  api_key_fallbacks?: string[]
}): boolean {
  // The bundled local runtime is always offered.
  if (provider.provider === 'llamacpp') return true
  // Anything the user added, with models discovered under it.
  if (!isPredefinedProvider(provider.provider)) return provider.models.length > 0
  // A built-in template: offered once it has a key, or models the user added.
  return providerHasRemoteApiKeys(provider) || provider.models.length > 0
}
