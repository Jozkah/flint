import { useEffect } from 'react'
import { create } from 'zustand'
import {
  endpointDiagnostics,
  endpointOf,
  refreshEndpoint,
  type EndpointDiagnostics,
} from '@/lib/providerFetch'
import {
  classifyModelLocation,
  type ModelLocation,
} from '@/lib/modelLocation'

/**
 * What the canonical resolver has decided about each provider endpoint.
 *
 * Only single-label hostnames need this: everything else is settled by the URL
 * alone. `llm-host` is the case that does -- it is local exactly when the address
 * the transport selected for it is local -- so the answer has to come from the
 * transport rather than from a guess about the name.
 */
type State = {
  byEndpoint: Record<string, EndpointDiagnostics | null>
  /** Endpoints a lookup is already in flight for. */
  pending: Record<string, boolean>
  resolve: (baseUrl: string) => Promise<void>
  /** Forget an endpoint: the provider was edited, or the user asked again. */
  invalidate: (baseUrl?: string) => Promise<void>
}

/** How often an unsettled endpoint is asked about again (a cache read). */
export const RECHECK_MS = 3000

const keyOf = (baseUrl: string) => {
  const endpoint = endpointOf(baseUrl)
  return endpoint ? `${endpoint.host.toLowerCase()}:${endpoint.port}` : null
}

export const useEndpointLocations = create<State>()((set, get) => ({
  byEndpoint: {},
  pending: {},

  resolve: async (baseUrl) => {
    const key = keyOf(baseUrl)
    const endpoint = endpointOf(baseUrl)
    if (!key || !endpoint) return
    // Only a real answer is final. `null` means the resolver has not seen the
    // endpoint yet -- nothing has connected to it -- and caching that as the
    // answer kept a tailnet host like `llm-host` "checking", out of both LOCAL
    // and REMOTE, for the rest of the session.
    if (get().pending[key] || get().byEndpoint[key]) return
    set((s) => ({ pending: { ...s.pending, [key]: true } }))
    try {
      const diagnostics = await endpointDiagnostics(endpoint.host, endpoint.port)
      set((s) => ({ byEndpoint: { ...s.byEndpoint, [key]: diagnostics } }))
    } catch {
      // A lookup that could not run leaves the endpoint unresolved rather than
      // recording an answer nobody gave.
      set((s) => ({ byEndpoint: { ...s.byEndpoint, [key]: null } }))
    } finally {
      set((s) => {
        const pending = { ...s.pending }
        delete pending[key]
        return { pending }
      })
    }
  },

  invalidate: async (baseUrl) => {
    if (!baseUrl) {
      await refreshEndpoint()
      set({ byEndpoint: {}, pending: {} })
      return
    }
    const key = keyOf(baseUrl)
    const endpoint = endpointOf(baseUrl)
    if (!key || !endpoint) return
    await refreshEndpoint(endpoint.host, endpoint.port)
    set((s) => {
      const byEndpoint = { ...s.byEndpoint }
      delete byEndpoint[key]
      return { byEndpoint }
    })
  },
}))

/** The diagnostics held for a base URL, if any have been recorded. */
export function diagnosticsFor(
  byEndpoint: Record<string, EndpointDiagnostics | null>,
  baseUrl: string | null | undefined
): EndpointDiagnostics | null | undefined {
  if (!baseUrl) return undefined
  const key = keyOf(baseUrl)
  return key ? byEndpoint[key] : undefined
}

/**
 * Where each of these providers runs its inference.
 *
 * Resolves the ones that cannot be decided from the URL alone, and returns a
 * classifier the caller can group by.
 */
export function useProviderLocations(
  providers: readonly { provider: string; base_url?: string }[],
  hasBuiltInEngine: (provider: string) => boolean
): (provider: { provider: string; base_url?: string }) => ModelLocation {
  const byEndpoint = useEndpointLocations((s) => s.byEndpoint)
  const resolve = useEndpointLocations((s) => s.resolve)

  useEffect(() => {
    const pendingUrls = () =>
      providers
        .filter((p) => p.base_url && !hasBuiltInEngine(p.provider))
        // Only the resolver-dependent ones cost a lookup.
        .filter((p) => classifyModelLocation({ baseUrl: p.base_url }) === 'checking')
        .map((p) => p.base_url as string)
        .filter((url) => !diagnosticsFor(useEndpointLocations.getState().byEndpoint, url))
    const ask = () => {
      for (const url of pendingUrls()) void resolve(url)
    }
    ask()
    // The resolver learns an endpoint when something first connects to it,
    // which is usually after this renders. Asking again is a read of its
    // cache, not a lookup, so keep asking while any endpoint is unsettled.
    const timer = setInterval(() => {
      if (pendingUrls().length === 0) clearInterval(timer)
      else ask()
    }, RECHECK_MS)
    return () => clearInterval(timer)
    // `providers` is rebuilt each render by its callers; the endpoints are what
    // matter, so depend on those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.map((p) => p.base_url ?? '').join('|'), resolve])

  return (provider) =>
    classifyModelLocation({
      baseUrl: provider.base_url,
      builtInEngine: hasBuiltInEngine(provider.provider),
      diagnostics: diagnosticsFor(byEndpoint, provider.base_url),
    })
}
