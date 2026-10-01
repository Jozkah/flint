// The phone's HTTP client for the desktop's remote-access API
// (src-tauri/src/core/remote/server.rs). Same origin as the page, so no CORS;
// every call but pairing carries `Authorization: Bearer <token>`.

import {
  REMOTE_API_PREFIX,
  type PairResponse,
  type PairStatus,
  type RemoteMethod,
  type RemoteMethods,
} from '@/lib/remote/protocol'
import type { PairingStore } from './storage'

/** A failed call. `code` is the server's or the desktop's error code, or
 * `network` / `unauthorized` from the client itself. */
export class RemoteCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0
  ) {
    super(message)
    this.name = 'RemoteCallError'
  }
}

export type Me = { id: string; name: string; pairedAt: number }

export type ClientOptions = {
  store: PairingStore
  /** Called once when the desktop no longer accepts this phone's token. */
  onUnauthorized?: () => void
  fetchImpl?: typeof fetch
  /** Base URL of the listener; the page's own origin by default. */
  base?: string
  /** How long a call may take before it counts as timed out (ms). */
  timeoutMs?: number
}

let seq = 0
const nextId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`

export class RemoteClient {
  private readonly store: PairingStore
  private readonly fetchImpl: typeof fetch
  private readonly base: string
  private onUnauthorized?: () => void
  private readonly timeoutMs: number

  constructor(opts: ClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 40_000
    this.store = opts.store
    this.fetchImpl = opts.fetchImpl ?? ((...a) => globalThis.fetch(...a))
    this.base = (opts.base ?? '') + REMOTE_API_PREFIX
    this.onUnauthorized = opts.onUnauthorized
  }

  setUnauthorizedHandler(fn: () => void) {
    this.onUnauthorized = fn
  }

  get token(): string | null {
    return this.store.get()?.token ?? null
  }

  private async request<T>(
    path: string,
    init: Omit<RequestInit, 'headers'> & { auth?: boolean; headers?: Record<string, string>; timeoutMs?: number } = {}
  ): Promise<T> {
    const { auth = true, headers = {}, timeoutMs = this.timeoutMs, ...rest } = init
    const h: Record<string, string> = { Accept: 'application/json', ...headers }
    if (auth) {
      const token = this.token
      if (!token) throw this.unauthorized()
      h.Authorization = `Bearer ${token}`
    }
    let res: Response
    const abort = typeof AbortController !== 'undefined' ? new AbortController() : null
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      abort?.abort()
    }, timeoutMs)
    try {
      res = await this.fetchImpl(this.base + path, {
        ...rest,
        headers: h,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        ...(abort ? { signal: abort.signal } : {}),
      })
    } catch {
      if (timedOut) throw new RemoteCallError('timeout', "Your computer didn't answer in time")
      throw new RemoteCallError('network', "Can't reach your computer")
    } finally {
      clearTimeout(timer)
    }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    if (res.status === 401 && auth) throw this.unauthorized()
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string } } | null)?.error
      throw new RemoteCallError(err?.code ?? 'http', err?.message ?? `Request failed (${res.status})`, res.status)
    }
    return body as T
  }

  /** Forgets the token and tells the app, once per loss. */
  private unauthorized(): RemoteCallError {
    if (this.store.get()) {
      this.store.clear()
      this.onUnauthorized?.()
    }
    return new RemoteCallError('unauthorized', "This phone isn't paired", 401)
  }

  /** Calls a method on the desktop window. Throws RemoteCallError with the
   * desktop's code (`not_implemented`, `not_found`, ...) when it refuses. */
  async rpc<M extends RemoteMethod>(
    method: M,
    params?: RemoteMethods[M]['params']
  ): Promise<RemoteMethods[M]['result']> {
    const id = nextId()
    const reply = await this.request<{ id: string; result?: unknown; error?: { code: string; message: string } }>(
      '/rpc',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, method, params: params ?? {} }),
        // Transcription can run long on the computer (its own cap is 150 s).
        ...(method === 'voice.transcribe' ? { timeoutMs: 160_000 } : {}),
      }
    )
    if (reply?.error) throw new RemoteCallError(reply.error.code, reply.error.message)
    return reply?.result as RemoteMethods[M]['result']
  }

  me(): Promise<Me> {
    return this.request<Me>('/me')
  }

  /** Unpairs this phone on the desktop, then forgets the token. */
  async unpair(): Promise<void> {
    try {
      await this.request('/me', { method: 'DELETE' })
    } finally {
      this.store.clear()
    }
  }

  pair(code: string, deviceName: string): Promise<PairResponse> {
    return this.request<PairResponse>('/pair', {
      method: 'POST',
      auth: false,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName }),
    })
  }

  pairStatus(pollId: string): Promise<PairStatus> {
    return this.request<PairStatus>('/pair/status', {
      auth: false,
      headers: { 'X-Flint-Pairing': pollId },
    })
  }
}
