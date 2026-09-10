import { Channel, invoke } from '@tauri-apps/api/core'

/**
 * The one way the web app talks to an OpenAI-compatible provider.
 *
 * Model discovery, chat completions, embeddings, health checks and connection
 * tests all call this, so every provider request is resolved and dialled by the
 * same code in `core/net/transport.rs`. That matters for a short hostname like
 * `v100`, which can resolve to both the right machine on the tailnet and a
 * stranger on the public internet: the choice between them is made once, in one
 * place, rather than differently by whichever caller happened to issue the
 * request.
 *
 * It is `fetch`-shaped so callers -- including the AI SDK providers, which take
 * a `fetch` -- need no special handling. The URL is passed through untouched;
 * nothing here rewrites a hostname to an address.
 */

/** Mirrors `core::net::transport::StreamChunk`. */
type StreamChunk =
  | {
      kind: 'head'
      status: number
      statusText: string
      headers: Record<string, string>
      peer: string | null
      snapshot: PromptSnapshotRef | null
    }
  | { kind: 'data'; b64: string }
  | { kind: 'end' }
  | { kind: 'error'; message: string }

/** What the transport recorded about a dispatched request. */
export type PromptSnapshotRef = {
  id: string
  hash: string
  redactions: number
  /**
   * The dispatch this snapshot is of.
   *
   * Echoed back by the transport so a count, a snapshot and a rendered turn
   * can all name the same model call rather than being matched by position.
   */
  invocation?: string
}

/**
 * Where a snapshot reference goes when one is taken.
 *
 * The AI SDK owns the call that produced it and has nowhere to return it, so
 * the transport hands it here instead. Registered by whoever renders the
 * timeline; unset outside that.
 */
type SnapshotSink = (session: string, ref: PromptSnapshotRef) => void
let snapshotSink: SnapshotSink | null = null

export function setSnapshotSink(sink: SnapshotSink | null): void {
  snapshotSink = sink
}

/** Header names carrying the dispatch identity. Consumed here, never sent. */
const DISPATCH_HEADER_FIELDS: Record<string, string> = {
  'x-jan-session': 'session',
  'x-jan-run': 'run',
  'x-jan-thread': 'thread',
  'x-jan-agent': 'agent',
  'x-jan-provider': 'provider',
}

/** Mirrors `core::net::commands::EndpointDiagnostics`. */
export type EndpointDiagnostics = {
  host: string
  port: number
  localName: boolean
  candidates: { address: string; class: string; eligible: boolean }[]
  selected: string | null
  suppressedPublic: boolean
  responded: string | null
}

function bytesOf(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Whether the Tauri IPC bridge is actually present. */
export function hasTauriRuntime(): boolean {
  const w = globalThis as typeof globalThis & {
    __TAURI__?: unknown
    __TAURI_INTERNALS__?: unknown
  }
  return (
    typeof w.__TAURI__ !== 'undefined' ||
    typeof w.__TAURI_INTERNALS__ !== 'undefined'
  )
}

function headersToRecord(
  init?: RequestInit,
  request?: Request
): Record<string, string> {
  const out: Record<string, string> = {}
  const source = init?.headers ?? request?.headers
  if (!source) return out
  if (typeof Headers !== 'undefined' && source instanceof Headers) {
    source.forEach((value, key) => {
      out[key] = value
    })
    return out
  }
  if (Array.isArray(source)) {
    for (const [key, value] of source) out[key] = String(value)
    return out
  }
  for (const [key, value] of Object.entries(source as Record<string, string>)) {
    out[key] = String(value)
  }
  return out
}

async function bodyText(
  init?: RequestInit,
  request?: Request
): Promise<string | null> {
  const body = init?.body
  if (body === undefined || body === null) {
    // A `Request` object carries its own body.
    if (request && request.body) return await request.text()
    return null
  }
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer)
    return new TextDecoder().decode(new Uint8Array(body))
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return body.toString()
  }
  // Blob, FormData and ReadableStream do not occur on provider APIs, which are
  // JSON. Say so rather than silently sending an empty body.
  throw new Error(
    'This request body type is not supported by the provider transport; provider APIs take JSON.'
  )
}

/**
 * A `fetch` that goes through the canonical Rust transport.
 *
 * The response body is streamed, so a token stream arrives incrementally rather
 * than after the whole completion is finished.
 */
export const providerFetch: typeof globalThis.fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const request = input instanceof Request ? input : undefined
  const url =
    request?.url ?? (input instanceof URL ? input.toString() : String(input))
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()

  const headers = headersToRecord(init, request)
  // The dispatch identity travels as headers because the AI SDK gives no other
  // way to thread it through. It is for the transport, not the provider, so it
  // is lifted out here and never reaches the wire.
  const identity: Record<string, string> = {}
  for (const [header, field] of Object.entries(DISPATCH_HEADER_FIELDS)) {
    const value = headers[header] ?? headers[header.toUpperCase()]
    if (value) identity[field] = value
    delete headers[header]
    delete headers[header.toUpperCase()]
  }

  // Names the stream so it can be stopped. A body nobody is reading any more
  // -- the caller aborted, or the consumer released the stream once it had
  // what it wanted -- must end the request, or the connection stays open and
  // whoever is waiting on that body waits forever.
  const streamId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  // A model dispatch names itself. The snapshot, the provider's usage count and
  // the turn that renders it are all bound to this id, and nothing else ever
  // assigned one: every snapshot came back with an empty invocation, so the
  // usage record -- which refuses to write an unbound count -- was never
  // written at all. One fetch is one dispatch, so an SDK retry is a new fetch
  // and correctly a new invocation. Only dispatches that carry a session get
  // one; model discovery and health checks are not snapshotted.
  const invocationId = identity.session ? `inv-${streamId.slice(2)}` : undefined

  const payload = {
    url,
    method,
    headers,
    body: await bodyText(init, request),
    timeoutSecs: null as number | null,
    streamId,
    ...identity,
    ...(invocationId ? { invocationId } : {}),
  }

  const signal = init?.signal ?? request?.signal
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    void invoke('provider_http_cancel', { streamId }).catch(() => {})
  }

  return await new Promise<Response>((resolve, reject) => {
    let settled = false
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    // Chunks that arrive before the consumer pulls; the channel does not wait.
    const pending: Uint8Array[] = []
    let ended = false
    let failure: Error | null = null

    const drain = () => {
      if (!controller) return
      while (pending.length) controller.enqueue(pending.shift() as Uint8Array)
      if (failure) {
        controller.error(failure)
        controller = null
        return
      }
      if (ended) {
        controller.close()
        controller = null
      }
    }

    if (signal) {
      if (signal.aborted) {
        settled = true
        stop()
        reject(new DOMException('The request was aborted.', 'AbortError'))
        return
      }
      signal.addEventListener(
        'abort',
        () => {
          stop()
          const error = new DOMException('The request was aborted.', 'AbortError')
          if (!settled) {
            settled = true
            reject(error)
          } else {
            failure = error
            drain()
          }
        },
        { once: true }
      )
    }

    const channel = new Channel<StreamChunk>()
    channel.onmessage = (chunk) => {
      switch (chunk.kind) {
        case 'head': {
          if (settled) return
          settled = true
          if (chunk.snapshot && identity.session) {
            snapshotSink?.(identity.session, chunk.snapshot)
          }
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              controller = c
              drain()
            },
            cancel() {
              // The consumer let go: stop the request rather than reading a
              // body into nothing.
              controller = null
              stop()
            },
          })
          // `Response` refuses a body on 204/205/304, and the transport never
          // produces one for them either.
          const bodyless = [204, 205, 304].includes(chunk.status)
          resolve(
            new Response(bodyless ? null : body, {
              status: chunk.status,
              statusText: chunk.statusText,
              headers: chunk.headers,
            })
          )
          break
        }
        case 'data':
          pending.push(bytesOf(chunk.b64))
          drain()
          break
        case 'end':
          ended = true
          stopped = true
          drain()
          break
        case 'error': {
          const error = new Error(chunk.message)
          if (!settled) {
            settled = true
            reject(error)
          } else {
            failure = error
            drain()
          }
          break
        }
      }
    }

    invoke('provider_http_stream', { request: payload, channel }).catch(
      (e: unknown) => {
        const error =
          e instanceof Error
            ? e
            : new Error(typeof e === 'string' ? e : String(e))
        if (!settled) {
          settled = true
          reject(error)
        } else {
          failure = error
          drain()
        }
      }
    )
  })
}

/**
 * `providerFetch` where the Tauri bridge exists, the platform's own `fetch`
 * where it does not (the browser build, and tests).
 */
export function runtimeProviderFetch(): typeof globalThis.fetch {
  return hasTauriRuntime() ? providerFetch : globalThis.fetch
}

/** What was resolved for an endpoint, for the provider details surface. */
export async function endpointDiagnostics(
  host: string,
  port: number
): Promise<EndpointDiagnostics | null> {
  if (!hasTauriRuntime()) return null
  return await invoke<EndpointDiagnostics | null>(
    'provider_endpoint_diagnostics',
    { host, port }
  )
}

/**
 * Forget what was resolved for an endpoint: the provider was edited, the
 * network moved, or the user asked to try again.
 */
export async function refreshEndpoint(
  host?: string,
  port?: number
): Promise<void> {
  if (!hasTauriRuntime()) return
  await invoke('provider_endpoint_refresh', {
    host: host ?? null,
    port: port ?? null,
  })
}

/** The host and port a configured base URL will actually be dialled at. */
export function endpointOf(
  baseUrl: string
): { host: string; port: number } | null {
  try {
    const url = new URL(baseUrl)
    const port = url.port
      ? Number(url.port)
      : url.protocol === 'https:'
        ? 443
        : url.protocol === 'http:'
          ? 80
          : NaN
    if (!url.hostname || Number.isNaN(port)) return null
    return { host: url.hostname, port }
  } catch {
    return null
  }
}
