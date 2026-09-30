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
  searchProvider: string
  apiKeys: Record<string, string>
  endpoints: Record<string, string>
  setWebSearchEnabled: (value: boolean) => void
  setSearchProvider: (value: string) => void
  setApiKey: (providerId: string, value: string) => void
  setEndpoint: (providerId: string, value: string) => void
}

export const useWebSearchConfig = create<WebSearchConfigState>()(
  persist(
    (set, get) => ({
      webSearchEnabled: true,
      searchProvider: DEFAULT_SEARCH_PROVIDER,
      apiKeys: {},
      endpoints: {},
      setWebSearchEnabled: (webSearchEnabled) => set({ webSearchEnabled }),
      setSearchProvider: (searchProvider) => set({ searchProvider }),
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
        endpoints: state.endpoints,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
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
