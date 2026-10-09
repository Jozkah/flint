/**
 * Classifying provider endpoints, and explaining why one of them failed.
 *
 * Motivated by a real report: four providers pointed at `http://llm-host:8080/v1`
 * and the app said only "Forbidden". The endpoint was in fact answered by
 * Cloudflare, because the bare hostname resolved through a search domain to a
 * public record instead of the machine on the LAN, so requests meant for a
 * local server left the machine entirely. "Forbidden" was true and useless;
 * what the user needed was the endpoint, the status, and who answered.
 */

import { isLoopback, originOf } from '@/hooks/useProviderReachability'
import { errorText } from '@/lib/errorText'

export type EndpointScope = 'loopback' | 'private' | 'public' | 'unknown'

const PRIVATE_V4 = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^169\.254\./,
  // Tailscale and other CGNAT overlays: 100.64.0.0/10.
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
]

/** Hostnames that only ever name something on this machine or this network. */
const PRIVATE_SUFFIXES = ['.local', '.internal', '.lan', '.home.arpa', '.ts.net']

/**
 * Where an endpoint lives: on this machine, on this network, or on the
 * internet.
 *
 * A bare hostname with no dots (`llm-host`) is *unknown*, not private: whether it
 * resolves to a machine on the LAN or to a public record depends on the
 * resolver's search domains, and that is exactly the ambiguity that produced
 * the report above.
 */
export function endpointScope(url: string | null | undefined): EndpointScope {
  const origin = originOf(url ?? undefined)
  if (!origin) return 'unknown'
  if (isLoopback(origin)) return 'loopback'

  let host: string
  try {
    host = new URL(origin).hostname.toLowerCase()
  } catch {
    return 'unknown'
  }

  const bare = host.replace(/^\[|\]$/g, '')
  if (bare === '0.0.0.0' || bare === '::') return 'loopback'
  if (PRIVATE_V4.some((re) => re.test(bare))) return 'private'
  // Unique local IPv6 (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/i.test(bare) || /^fe[89ab][0-9a-f]:/i.test(bare))
    return 'private'
  if (PRIVATE_SUFFIXES.some((suffix) => bare.endsWith(suffix))) return 'private'
  // A name with no dot is resolver-dependent; we cannot claim it is either.
  if (!bare.includes('.')) return 'unknown'
  return 'public'
}

/**
 * Whether this endpoint should be treated as a local engine rather than a
 * remote service: no credential is implied, and no cloud discovery applies.
 */
export function isLocalEndpoint(url: string | null | undefined): boolean {
  const scope = endpointScope(url)
  return scope === 'loopback' || scope === 'private'
}

export type EndpointFailure = {
  /** The provider as the user named it. */
  provider: string
  /** The full request URL, so the message names what was actually called. */
  url: string
  method?: string
  /** Absent for a transport failure, where nothing answered. */
  status?: number
  statusText?: string
  /** `Server:` response header, which is how a proxy gives itself away. */
  server?: string | null
  /** The transport error, when the request never completed. */
  cause?: unknown
}

/**
 * A single sentence naming the provider, the endpoint and the status, followed
 * by the most likely remedy. Never a bare status word, and never a raw object.
 */
/**
 * An endpoint failure that has already been explained.
 *
 * Marked so callers can re-throw it untouched. Wrapping it in "Unexpected
 * error while fetching models from X" buried the one sentence that said what
 * actually happened -- the endpoint, the status, and who answered -- inside a
 * generic one that said nothing.
 */
export class EndpointError extends Error {
  readonly endpoint = true
  constructor(message: string) {
    super(message)
    this.name = 'EndpointError'
  }
}

/** Whether this error already carries an actionable explanation. */
export function isEndpointError(e: unknown): e is EndpointError {
  return e instanceof EndpointError || (e as EndpointError)?.endpoint === true
}

export function describeEndpointFailure(failure: EndpointFailure): string {
  const { provider, url, method = 'GET', status, statusText } = failure
  const scope = endpointScope(url)
  const where = `${method} ${url}`

  if (status === undefined) {
    // The transport's own sentence, minus the part this message already says.
    // reqwest ends every connect failure with "error sending request for url
    // (...)", and repeating the URL a second and third time in one toast
    // pushes the part that matters -- what the name resolved to -- off the
    // end of it.
    const detail = errorText(failure.cause, 'the request did not complete')
      .replace(/[:,]?\s*error sending request for url \([^)]*\)\.?\s*$/i, '')
      .trim()
    const host = originOf(url) ?? url
    return (
      `${provider}: could not reach ${where} — ${detail || 'the request did not complete'}. ` +
      `Check that the server is running and listening on ${host}.`
    )
  }

  const answeredBy = failure.server ? ` (answered by ${failure.server})` : ''
  const head = `${provider}: ${where} returned ${status}${
    statusText ? ` ${statusText}` : ''
  }${answeredBy}`

  // A local-looking endpoint answered by something that is plainly a CDN or
  // reverse proxy means the request left the machine.
  const proxyAnswered = /cloudflare|akamai|fastly|cloudfront|nginx|envoy/i.test(
    failure.server ?? ''
  )
  if (
    (status === 401 || status === 403) &&
    proxyAnswered &&
    scope !== 'public'
  ) {
    return (
      `${head}. The request reached a proxy on the internet rather than your ` +
      `own server, so the hostname is resolving to a public address. Point the ` +
      `provider at the machine's address directly, or fix the name resolution.`
    )
  }

  switch (status) {
    case 401:
      return `${head}. The endpoint requires an API key; add one for this provider.`
    case 403:
      return (
        `${head}. The endpoint refused the request. If this is your own server, ` +
        `check what is answering at that address before changing any credential.`
      )
    case 404:
      return (
        `${head}. Nothing is served at that path. An OpenAI-compatible base URL ` +
        `ends at /v1, with no trailing /models or /chat/completions.`
      )
    case 429:
      return `${head}. The endpoint is rate limiting; retry later.`
    default:
      if (status >= 500)
        return `${head}. The server failed while handling the request; check its logs.`
      return `${head}.`
  }
}

/**
 * Chat-time counterpart of the model-list check: an AI SDK `APICallError`
 * carries the URL, status and response headers of the call that failed, so a
 * 401/403/404 can name the endpoint and who answered just as the model list
 * does. Any other error, or one without that detail, comes back unchanged.
 */
export function describeChatFailure(error: unknown, provider?: string): string {
  const fallback =
    error instanceof Error ? error.message : errorText(error, 'Error')
  const err = error as
    | { statusCode?: number; url?: string; responseHeaders?: Record<string, string>; message?: string; lastError?: unknown }
    | undefined
  const call = typeof err?.statusCode === 'number' ? err : (err?.lastError as typeof err)
  if (
    !call ||
    typeof call.url !== 'string' ||
    ![401, 403, 404].includes(call.statusCode ?? 0)
  ) {
    return fallback
  }
  const headers = call.responseHeaders ?? {}
  const server =
    Object.entries(headers).find(([k]) => k.toLowerCase() === 'server')?.[1] ??
    null
  const detail = describeEndpointFailure({
    provider: provider || originOf(call.url) || 'Provider',
    url: call.url,
    method: 'POST',
    status: call.statusCode,
    server,
  })
  return call.message && !detail.includes(call.message)
    ? `${detail} (${call.message})`
    : detail
}

/**
 * Model ids from an OpenAI-compatible `/v1/models` payload.
 *
 * llama.cpp answers with `data` *and* a non-standard `models` array, and some
 * servers answer with only one of them, so both are accepted. Anything that is
 * not a recognisable list yields an empty array rather than throwing, because
 * "this server lists no models" is a state the UI has to show truthfully.
 */
export function parseModelList(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const lists = [record.data, record.models].filter(Array.isArray) as unknown[][]
  const ids: string[] = []
  for (const list of lists) {
    for (const entry of list) {
      if (typeof entry === 'string') {
        if (entry.trim()) ids.push(entry.trim())
        continue
      }
      if (entry && typeof entry === 'object') {
        const item = entry as Record<string, unknown>
        const id = item.id ?? item.model ?? item.name
        if (typeof id === 'string' && id.trim()) ids.push(id.trim())
      }
    }
  }
  return [...new Set(ids)]
}
