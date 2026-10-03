/**
 * The window a local OpenAI-compatible server is running a model in.
 *
 * Nothing in a chat records it, and a custom server rarely names it in its
 * model list, so a conversation's context card had no size to divide by. A
 * llama-server says it at `/props` (`default_generation_settings.n_ctx`), which
 * is the number that matters: the window the server launched with, which can
 * be far below what the model was trained for.
 *
 * Only asked of an endpoint on this machine or this network. A hosted provider
 * is not probed, and a request is never made to an address the user did not
 * configure.
 */
import { providerFetch } from '@/lib/providerFetch'
import { isLocalEndpoint } from '@/lib/endpointDiagnostics'
import { usableContextValue } from '@/lib/modelCapabilities'

/** `http://host:port/props`, from a base URL that may end in `/v1`. */
export function propsUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null
  try {
    return `${new URL(baseUrl).origin}/props`
  } catch {
    return null
  }
}

/** The window out of a `/props` body, or null when it names none. */
export function parseServerWindow(props: unknown): number | null {
  if (!props || typeof props !== 'object') return null
  const body = props as Record<string, unknown>
  const defaults = body.default_generation_settings
  const fromDefaults =
    defaults && typeof defaults === 'object'
      ? usableContextValue((defaults as Record<string, unknown>).n_ctx)
      : null
  return fromDefaults ?? usableContextValue(body.n_ctx)
}

const TTL_MS = 60_000
const TIMEOUT_MS = 3_000
const cache = new Map<string, { at: number; tokens: number | null }>()
const inFlight = new Map<string, Promise<number | null>>()

/** Forget what was learned, for tests. */
export function resetServerWindowCache(): void {
  cache.clear()
  inFlight.clear()
}

/**
 * Ask a local server for its window. Null when the endpoint is not local, did
 * not answer, or is not a server that reports one; those are not errors, the
 * card simply has no size to show. Remembered for a minute, so a counter that
 * renders often asks once.
 */
export async function fetchServerWindow(
  baseUrl: string | null | undefined
): Promise<number | null> {
  const url = propsUrl(baseUrl)
  if (!url || !isLocalEndpoint(baseUrl)) return null

  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tokens
  const pending = inFlight.get(url)
  if (pending) return pending

  const request = (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await providerFetch(url, {
        method: 'GET',
        signal: controller.signal,
      })
      if (!response.ok) return null
      return parseServerWindow(await response.json())
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  })()
  inFlight.set(url, request)
  try {
    const tokens = await request
    cache.set(url, { at: Date.now(), tokens })
    return tokens
  } finally {
    inFlight.delete(url)
  }
}
