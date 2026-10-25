import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import { getServiceHub } from '@/hooks/useServiceHub'

export type WebSearchProviderMeta = {
  id: string
  label: string
  keyless: boolean
  secretKey: string
  homepage: string
  requiresEndpoint?: boolean
  /** Nothing to configure: no API key, no instance URL, no account. */
  noSetup?: boolean
}

export const WEB_SEARCH_PROVIDERS: WebSearchProviderMeta[] = [
  {
    id: 'exa',
    label: 'Exa',
    keyless: true,
    secretKey: 'exa-api-key',
    homepage: 'exa.ai',
  },
  {
    id: 'tavily',
    label: 'Tavily',
    keyless: false,
    secretKey: 'tavily-api-key',
    homepage: 'tavily.com',
  },
  {
    id: 'brave',
    label: 'Brave Search',
    keyless: false,
    secretKey: 'brave-api-key',
    homepage: 'brave.com',
  },
  {
    // Google results via the Serper API; `id` is the backend selector.
    id: 'serper',
    label: 'Google (Serper)',
    keyless: false,
    secretKey: 'serper-api-key',
    homepage: 'serper.dev',
  },
  {
    id: 'searxng',
    label: 'SearXNG',
    keyless: true,
    secretKey: '',
    homepage: 'searxng.org',
    requiresEndpoint: true,
  },
  {
    id: 'you',
    label: 'You.com',
    keyless: true,
    secretKey: 'you-api-key',
    homepage: 'you.com',
  },
  {
    // Reads DuckDuckGo's HTML results page: there is no API and nothing to
    // configure, so no secret and no endpoint.
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    keyless: true,
    secretKey: '',
    homepage: 'duckduckgo.com',
    noSetup: true,
  },
]

export const DEFAULT_SEARCH_PROVIDER = 'exa'

/**
 * One step of the ordered search chain. `useKey` picks the keyed mode of a
 * provider that also works without a key (Exa, You.com); providers that only
 * work one way ignore it.
 */
export type SearchChainEntry = {
  provider: string
  useKey: boolean
  enabled: boolean
}

export const chainEntryId = (e: Pick<SearchChainEntry, 'provider' | 'useKey'>) =>
  `${e.provider}:${e.useKey ? 'key' : 'free'}`

/** Whether an entry calls the provider with an API key. */
export const entryUsesKey = (e: Pick<SearchChainEntry, 'provider' | 'useKey'>) => {
  const meta = getProviderMeta(e.provider)
  if (!meta.secretKey) return false
  return !meta.keyless || e.useKey
}

/** Every provider/mode pair that can sit in the chain, in display order. */
export const chainEntryOptions = (): Pick<SearchChainEntry, 'provider' | 'useKey'>[] =>
  WEB_SEARCH_PROVIDERS.flatMap((p) =>
    p.keyless && p.secretKey
      ? [
          { provider: p.id, useKey: false },
          { provider: p.id, useKey: true },
        ]
      : [{ provider: p.id, useKey: !p.keyless }]
  )

/**
 * The chain for a store saved before the chain existed: what the single
 * provider used to do, keyless Exa and DuckDuckGo still backing each other up.
 */
export const legacyChain = (provider: string): SearchChainEntry[] => {
  const on = (provider: string, useKey: boolean) => ({ provider, useKey, enabled: true })
  switch (provider) {
    case 'exa':
      return [on('exa', true), on('exa', false), on('duckduckgo', false)]
    case 'duckduckgo':
      return [on('duckduckgo', false), on('exa', false)]
    case 'you':
      return [on('you', true), on('you', false)]
    default:
      return [on(getProviderMeta(provider).id, !getProviderMeta(provider).keyless)]
  }
}

export const DEFAULT_SEARCH_CHAIN: SearchChainEntry[] = [
  { provider: 'exa', useKey: false, enabled: true },
  { provider: 'duckduckgo', useKey: false, enabled: true },
]

/**
 * The entries a search call should try, in order: enabled ones whose key or
 * instance URL is set. A keyed entry without a key is left out instead of
 * silently running keyless, which would not be what the user ordered.
 */
export const buildSearchChain = (state: {
  searchChain: SearchChainEntry[]
  apiKeys: Record<string, string>
  endpoints: Record<string, string>
}): { provider: string; apiKey?: string; endpoint?: string }[] =>
  state.searchChain.flatMap((e) => {
    if (!e.enabled) return []
    const meta = getProviderMeta(e.provider)
    const endpoint = state.endpoints[meta.id]?.trim() || undefined
    if (meta.requiresEndpoint && !endpoint) return []
    if (entryUsesKey(e)) {
      const apiKey = state.apiKeys[meta.id]?.trim()
      return apiKey ? [{ provider: meta.id, apiKey, endpoint }] : []
    }
    return [{ provider: meta.id, endpoint }]
  })

/**
 * The provider's initial, drawn locally.
 *
 * Fetching the icon would tell a third party which search providers this
 * machine is looking at, for no benefit beyond decoration.
 */
export const providerInitial = (meta: WebSearchProviderMeta): string =>
  (meta.homepage.replace(/^[^a-z0-9]+/i, '')[0] ?? '?').toUpperCase()

export const getProviderMeta = (id: string): WebSearchProviderMeta =>
  WEB_SEARCH_PROVIDERS.find((p) => p.id === id) ?? WEB_SEARCH_PROVIDERS[0]

type WebSearchConfigState = {
  webSearchEnabled: boolean
  /** First enabled chain entry's provider, kept for labels. */
  searchProvider: string
  searchChain: SearchChainEntry[]
  apiKeys: Record<string, string>
  endpoints: Record<string, string>
  setWebSearchEnabled: (value: boolean) => void
  setSearchProvider: (value: string) => void
  setSearchChain: (value: SearchChainEntry[]) => void
  setApiKey: (providerId: string, value: string) => void
  setEndpoint: (providerId: string, value: string) => void
}

export const useWebSearchConfig = create<WebSearchConfigState>()(
  persist(
    (set, get) => ({
      webSearchEnabled: true,
      searchProvider: DEFAULT_SEARCH_PROVIDER,
      searchChain: DEFAULT_SEARCH_CHAIN,
      apiKeys: {},
      endpoints: {},
      setWebSearchEnabled: (webSearchEnabled) => set({ webSearchEnabled }),
      setSearchProvider: (searchProvider) => set({ searchProvider }),
      setSearchChain: (searchChain) =>
        set({
          searchChain,
          searchProvider:
            searchChain.find((e) => e.enabled)?.provider ?? get().searchProvider,
        }),
      setApiKey: (providerId, value) => {
        set({ apiKeys: { ...get().apiKeys, [providerId]: value } })
        const secretKey = getProviderMeta(providerId).secretKey
        if (!secretKey) return
        // Canonical secret store is the OS keyring, not settings.json.
        getServiceHub()
          .core()
          .invoke('set_secret', { key: secretKey, value })
          .catch((err) =>
            console.warn('Failed to persist web search API key to keyring:', err)
          )
      },
      // Instance URLs are not secrets; they persist in settings.json.
      setEndpoint: (providerId, value) =>
        set({ endpoints: { ...get().endpoints, [providerId]: value } }),
    }),
    {
      name: localStorageKey.settingWebSearch,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      // Never write API keys to plaintext settings.json; they live in the keyring.
      partialize: (state) => ({
        webSearchEnabled: state.webSearchEnabled,
        searchProvider: state.searchProvider,
        searchChain: state.searchChain,
        endpoints: state.endpoints,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const saved = state as Partial<WebSearchConfigState>
        if (!Array.isArray(saved.searchChain)) {
          useWebSearchConfig.setState({
            searchChain: legacyChain(state.searchProvider || DEFAULT_SEARCH_PROVIDER),
          })
        }
        for (const provider of WEB_SEARCH_PROVIDERS) {
          // Endpoint-only providers such as SearXNG have no secret to restore.
          // Calling the keyring with an empty key is both meaningless and can
          // surface platform-specific keyring errors during settings hydration.
          if (!provider.secretKey) continue
          getServiceHub()
            .core()
            .invoke<string | null>('get_secret', { key: provider.secretKey })
            .then((value) => {
              if (!value) return
              useWebSearchConfig.setState((s) => ({
                apiKeys: { ...s.apiKeys, [provider.id]: value },
              }))
            })
            .catch(() => {})
        }
      },
    }
  )
)
