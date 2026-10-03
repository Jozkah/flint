import { useCallback } from 'react'
import { isLocalProvider } from '@/lib/utils'
import { classifyModelLocation } from '@/lib/modelLocation'
import { isUnavailable, modelAvailability } from '@/lib/modelAvailability'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { useProviderReachability } from '@/hooks/useProviderReachability'
import { useModelFilter } from '@/hooks/useModelFilter'

type ProviderLike = Pick<ModelProvider, 'provider'> &
  Partial<
    Pick<ModelProvider, 'active' | 'base_url' | 'api_key' | 'api_key_fallbacks'>
  >

/**
 * `true` for a provider whose models the "hide unavailable" filter drops, and
 * only while that filter is on. Safe to call on every provider in a list.
 */
export function useHideUnavailable(): (provider: ProviderLike) => boolean {
  const hide = useModelFilter((s) => s.hideUnavailable)
  const unreachableOrigins = useProviderReachability((s) => s.unreachable)
  return useCallback(
    (provider) =>
      hide &&
      isUnavailable(
        modelAvailability({
          isLocal:
            classifyModelLocation({
              baseUrl: provider.base_url,
              builtInEngine: Boolean(isLocalProvider(provider.provider)),
            }) !== 'remote',
          providerActive: provider.active !== false,
          hasApiKey: Boolean(providerHasRemoteApiKeys(provider)),
          baseUrl: provider.base_url,
          unreachableOrigins,
        })
      ),
    [hide, unreachableOrigins]
  )
}
