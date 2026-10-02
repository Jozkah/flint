import { isEngineProviderName } from '@/lib/engineModels'
import { classifyModelLocation } from '@/lib/modelLocation'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'

type KeyStatusProvider = {
  provider: string
  base_url?: string
  api_key?: string
  api_key_fallbacks?: string[]
  settings?: { key: string }[]
}

/** What the provider list says about a provider that is switched on. */
export type ProviderKeyStatus =
  /** Runs in Flint's own engine. */
  | 'local'
  /** Remote, a key is saved. The network is not asked. */
  | 'keyed'
  /** Remote and a key is needed, but none is saved. */
  | 'missing'
  /** Needs no key: its settings have none, or it is a loopback or LAN endpoint. */
  | 'keyless'

/**
 * Whether a provider has what it needs to be called. Honest about only what is
 * known on this machine: a saved key is not proof the key works.
 */
export function providerKeyStatus(provider: KeyStatusProvider): ProviderKeyStatus {
  if (isEngineProviderName(provider.provider)) return 'local'
  if (providerHasRemoteApiKeys(provider)) return 'keyed'
  const declaresKey =
    !provider.settings?.length || provider.settings.some((s) => s.key === 'api-key')
  if (!declaresKey) return 'keyless'
  if (classifyModelLocation({ baseUrl: provider.base_url }) === 'local') return 'keyless'
  return 'missing'
}
