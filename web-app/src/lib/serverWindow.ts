/**
 * The window a local OpenAI-compatible server is running a model in.
 *
 * Nothing in a chat records it, and a custom server rarely names it in its
 * model list, so a conversation's context card had no size to divide by. Two
 * servers answer it, in different places:
 *
 * - llama-server, at `/props` (`default_generation_settings.n_ctx`): the window
 *   it launched with, which can be far below what the model was trained for.
 * - vLLM, which has no `/props`, in its model list: `GET /v1/models`, each
 *   entry's `max_model_len`.
 *
 * Only asked of an endpoint that is not a hosted service: this machine, this
 * network, or a bare hostname (`http://v100:8559/v1`), which is a LAN box as
 * often as not and is the user's own configured address either way. A hosted
 * provider is not probed.
 */
import { providerFetch } from '@/lib/providerFetch'
import { endpointScope } from '@/lib/endpointDiagnostics'
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

/**
 * The server's model list, from the base URL as typed: `…/v1` gives
 * `…/v1/models`, and a bare address gets the `/v1` an OpenAI-compatible server
 * serves it under.
 */
export function modelsUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null
  try {
    const url = new URL(baseUrl)
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.origin}${path || '/v1'}/models`
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

/**
 * The window of one model out of a model list (`max_model_len`).
 *
 * The entry for `modelId`, or the only entry when the list has just one: a
 * server that serves a single model does not mind what the chat calls it. More
 * than one entry and no match names nothing, rather than another model's.
 */
export function parseModelsWindow(
  list: unknown,
  modelId?: string | null
): number | null {
  if (!list || typeof list !== 'object') return null
  const data = (list as Record<string, unknown>).data
  if (!Array.isArray(data)) return null
  const entries = data.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === 'object'
  )
  const entry =
    entries.find((e) => modelId && e.id === modelId) ??
    (entries.length === 1 ? entries[0] : undefined)
  if (!entry) return null
  return (
    usableContextValue(entry.max_model_len) ??
    usableContextValue(entry.context_length) ??
    usableContextValue(entry.max_context_length)
  )
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

async function getJson(url: string): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await providerFetch(url, {
      method: 'GET',
      signal: controller.signal,
    })
    return response.ok ? await response.json() : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask a local server for its window. Null when the endpoint is not local, did
 * not answer, or reports none; those are not errors, the card simply has no
 * size to show. Remembered for a minute, so a counter that renders often asks
 * once.
 */
export async function fetchServerWindow(
  baseUrl: string | null | undefined,
  modelId?: string | null
): Promise<number | null> {
  const props = propsUrl(baseUrl)
  const models = modelsUrl(baseUrl)
  if (!props || !models || endpointScope(baseUrl) === 'public') return null

  const key = `${models}|${modelId ?? ''}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tokens
  const pending = inFlight.get(key)
  if (pending) return pending

  const request = (async () => {
    const fromProps = parseServerWindow(await getJson(props))
    if (fromProps != null) return fromProps
    return parseModelsWindow(await getJson(models), modelId)
  })()
  inFlight.set(key, request)
  try {
    const tokens = await request
    cache.set(key, { at: Date.now(), tokens })
    return tokens
  } finally {
    inFlight.delete(key)
  }
}
