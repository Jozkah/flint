// The desktop's event stream (`/remote/v1/events`), kept open with backoff.
//
// The token rides in the WebSocket subprotocol (`flint-auth.<token>`), never
// in the URL. A socket that the server closes as unpaired, or that never
// opens while `/me` answers 401, ends the pairing instead of retrying.

import {
  REMOTE_API_PREFIX,
  REMOTE_WS_AUTH_PREFIX,
  REMOTE_WS_PROTOCOL,
  type RemoteClientMessage,
  type RemoteEvent,
  type RemoteSocketMessage,
} from '@/lib/remote/protocol'

export type ConnectionState = 'connecting' | 'connected' | 'offline'

export type EventSocketOptions = {
  token: () => string | null
  onEvent: (event: RemoteEvent) => void
  onState: (state: ConnectionState) => void
  /** The pairing is gone (closed as unpaired, or `/me` says 401). */
  onUnauthorized: () => void
  /** Asks the server whether the token still works, after a failed open.
   * Resolves `false` for 401. */
  probe?: () => Promise<boolean>
  /** Missed events (the socket fell behind); the app should refetch. */
  onLagged?: () => void
  WebSocketImpl?: typeof WebSocket
  url?: string
  /** Delay before reconnect attempt `n` (0-based), in ms. */
  backoff?: (attempt: number) => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}

/** 1s, 2s, 4s ... capped at 30s, with up to 20% jitter so a room full of
 * phones does not reconnect in step after the computer wakes. */
export function defaultBackoff(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))
  return Math.round(base * (1 - 0.2 * random()))
}

/** WebSocket policy-violation close, used by the server for a revoked token. */
const CLOSE_POLICY = 1008
const PING_EVERY_MS = 25_000

export function eventsUrl(loc: { protocol: string; host: string } = globalThis.location): string {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${loc.host}${REMOTE_API_PREFIX}/events`
}

export class EventSocket {
  private ws: WebSocket | null = null
  private attempt = 0
  private timer: unknown = null
  private ping: ReturnType<typeof setInterval> | null = null
  private stopped = true
  /** Topics followed, with how many screens follow each. */
  private topics = new Map<string, number>()
  private readonly o: Required<
    Pick<EventSocketOptions, 'backoff' | 'setTimer' | 'clearTimer'>
  > &
    EventSocketOptions

  constructor(opts: EventSocketOptions) {
    this.o = {
      backoff: defaultBackoff,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      ...opts,
    }
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.open()
  }

  stop() {
    this.stopped = true
    if (this.timer !== null) this.o.clearTimer(this.timer)
    this.timer = null
    this.stopPing()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null
      try {
        ws.close(1000, 'bye')
      } catch {
        // Already closed.
      }
    }
    this.o.onState('offline')
  }

  /** Receive a topic's events (a conversation's stream) while followed.
   * Re-sent on every reconnect, since a new socket starts with none. */
  follow(topic: string): () => void {
    const n = this.topics.get(topic) ?? 0
    this.topics.set(topic, n + 1)
    if (n === 0) this.send({ type: 'subscribe', topics: [topic] })
    let done = false
    return () => {
      if (done) return
      done = true
      const left = (this.topics.get(topic) ?? 1) - 1
      if (left > 0) {
        this.topics.set(topic, left)
        return
      }
      this.topics.delete(topic)
      this.send({ type: 'unsubscribe', topics: [topic] })
    }
  }

  private hidden = false

  /** The page was hidden or shown: the server sends Web Push only while no
   * page of this phone is showing. */
  setHidden(hidden: boolean) {
    if (hidden === this.hidden) return
    this.hidden = hidden
    this.send({ type: 'visibility', hidden })
  }

  followed(): string[] {
    return [...this.topics.keys()]
  }

  private send(msg: RemoteClientMessage) {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) return
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // The close handler reconnects and re-subscribes.
    }
  }

  /** Reconnect now (the page came back to the foreground, the network
   * changed), instead of waiting out the backoff. */
  kick() {
    if (this.stopped) return
    if (this.ws && this.ws.readyState <= 1) return
    if (this.timer !== null) this.o.clearTimer(this.timer)
    this.timer = null
    this.attempt = 0
    this.open()
  }

  private open() {
    const token = this.o.token()
    if (!token) {
      this.stopped = true
      this.o.onUnauthorized()
      return
    }
    this.o.onState('connecting')
    const Impl = this.o.WebSocketImpl ?? globalThis.WebSocket
    let ws: WebSocket
    try {
      ws = new Impl(this.o.url ?? eventsUrl(), [REMOTE_WS_PROTOCOL, `${REMOTE_WS_AUTH_PREFIX}${token}`])
    } catch {
      this.retry(false)
      return
    }
    this.ws = ws
    let ready = false
    ws.onmessage = (e) => {
      let msg: RemoteSocketMessage
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (msg.type === 'ready') {
        ready = true
        this.attempt = 0
        if (this.topics.size) this.send({ type: 'subscribe', topics: [...this.topics.keys()] })
        if (this.hidden) this.send({ type: 'visibility', hidden: true })
        this.o.onState('connected')
        this.startPing()
      } else if (msg.type === 'event') {
        this.o.onEvent(msg.event)
      } else if (msg.type === 'lagged') {
        this.o.onLagged?.()
      }
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      this.ws = null
      this.stopPing()
      if (this.stopped) return
      if (e.code === CLOSE_POLICY && /unpaired|unauthorized/.test(e.reason)) {
        this.stopped = true
        this.o.onState('offline')
        this.o.onUnauthorized()
        return
      }
      this.retry(ready)
    }
  }

  private async retry(wasReady: boolean) {
    this.o.onState('offline')
    // A socket refused before it opened may be a revoked token (the server
    // answers the upgrade with 401, which the browser does not show us).
    if (!wasReady && this.o.probe) {
      const ok = await this.o.probe().catch(() => true)
      if (this.stopped) return
      if (!ok) {
        this.stopped = true
        this.o.onUnauthorized()
        return
      }
    }
    const delay = this.o.backoff(this.attempt++)
    this.timer = this.o.setTimer(() => {
      this.timer = null
      if (!this.stopped) this.open()
    }, delay)
  }

  private startPing() {
    this.stopPing()
    this.ping = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ type: 'ping' }))
      } catch {
        // The close handler reconnects.
      }
    }, PING_EVERY_MS)
  }

  private stopPing() {
    if (this.ping) clearInterval(this.ping)
    this.ping = null
  }
}
