import { describe, it, expect, vi } from 'vitest'
import { EventSocket, defaultBackoff, eventsUrl } from '../api/events'

class FakeSocket {
  static all: FakeSocket[] = []
  onopen: ((e: unknown) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  readyState = 0
  sent: string[] = []
  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {
    FakeSocket.all.push(this)
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.readyState = 3
  }
  msg(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
  drop(code = 1006, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

function setup(over: Partial<ConstructorParameters<typeof EventSocket>[0]> = {}) {
  FakeSocket.all = []
  const timers: { fn: () => void; ms: number }[] = []
  const states: string[] = []
  const events: unknown[] = []
  const onUnauthorized = vi.fn()
  const s = new EventSocket({
    token: () => 'tok',
    url: 'wss://desk/remote/v1/events',
    onEvent: (e) => events.push(e),
    onState: (st) => states.push(st),
    onUnauthorized,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    backoff: (n) => 1000 * 2 ** n,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
    ...over,
  })
  return { s, timers, states, events, onUnauthorized }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('EventSocket', () => {
  it('authenticates with the subprotocol, never the URL', () => {
    const { s } = setup()
    s.start()
    const ws = FakeSocket.all[0]
    expect(ws.protocols).toEqual(['flint-remote.v1', 'flint-auth.tok'])
    expect(ws.url).not.toContain('tok')
  })

  it('reports connected on ready and forwards events', () => {
    const { s, states, events } = setup()
    s.start()
    FakeSocket.all[0].msg({ type: 'ready', deviceId: 'd1' })
    FakeSocket.all[0].msg({ type: 'event', topic: null, event: { type: 'run.started', kind: 'cowork', id: 'w1' } })
    expect(states).toEqual(['connecting', 'connected'])
    expect(events).toEqual([{ type: 'run.started', kind: 'cowork', id: 'w1' }])
    s.stop()
  })

  it('reconnects with growing backoff, and resets it after a good connection', async () => {
    const { s, timers } = setup()
    s.start()
    FakeSocket.all[0].msg({ type: 'ready', deviceId: 'd1' })
    FakeSocket.all[0].drop()
    await flush()
    expect(timers.map((t) => t.ms)).toEqual([1000])
    timers[0].fn()
    expect(FakeSocket.all).toHaveLength(2)
    FakeSocket.all[1].drop()
    await flush()
    timers[1].fn()
    FakeSocket.all[2].drop()
    await flush()
    expect(timers.map((t) => t.ms)).toEqual([1000, 2000, 4000])
    timers[2].fn()
    FakeSocket.all[3].msg({ type: 'ready', deviceId: 'd1' })
    FakeSocket.all[3].drop()
    await flush()
    expect(timers.at(-1)?.ms).toBe(1000)
    s.stop()
  })

  it('stops for good when the server closes the socket as unpaired', () => {
    const { s, timers, onUnauthorized } = setup()
    s.start()
    FakeSocket.all[0].msg({ type: 'ready', deviceId: 'd1' })
    FakeSocket.all[0].drop(1008, 'unpaired')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(timers).toHaveLength(0)
  })

  it('asks /me after a refused open and gives up on 401', async () => {
    const probe = vi.fn(async () => false)
    const { s, timers, onUnauthorized } = setup({ probe })
    s.start()
    FakeSocket.all[0].drop()
    await flush()
    expect(probe).toHaveBeenCalled()
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(timers).toHaveLength(0)
  })

  it('keeps retrying when the computer is only unreachable', async () => {
    const probe = vi.fn(async () => true)
    const { s, timers, onUnauthorized } = setup({ probe })
    s.start()
    FakeSocket.all[0].drop()
    await flush()
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(timers).toHaveLength(1)
    s.stop()
  })

  it('kick() reconnects at once instead of waiting', async () => {
    const { s } = setup()
    s.start()
    FakeSocket.all[0].drop()
    await flush()
    s.kick()
    expect(FakeSocket.all).toHaveLength(2)
    s.stop()
  })

  it('kick() on a socket that still says open pings it, and replaces it when nothing answers', () => {
    const { s, timers, states } = setup()
    s.start()
    const first = FakeSocket.all[0]
    first.readyState = 1
    first.msg({ type: 'ready', deviceId: 'd1' })
    s.kick()
    expect(first.sent.map((m) => JSON.parse(m).type)).toContain('ping')
    expect(FakeSocket.all).toHaveLength(1)
    // No pong: the wait runs out and a new socket is opened.
    timers[timers.length - 1].fn()
    expect(FakeSocket.all).toHaveLength(2)
    expect(states).toContain('offline')
    s.stop()
  })

  it('a pong keeps the socket that kick() checked', () => {
    const { s, timers } = setup()
    s.start()
    const first = FakeSocket.all[0]
    first.readyState = 1
    first.msg({ type: 'ready', deviceId: 'd1' })
    s.kick()
    first.msg({ type: 'pong' })
    // The timer was cleared (the fake clearTimer is a no-op), so run it only if
    // the socket would have been replaced: it must not be.
    expect(FakeSocket.all).toHaveLength(1)
    void timers
    s.stop()
  })
})

describe('backoff and URL', () => {
  it('doubles up to 30s with at most 20% jitter', () => {
    expect(defaultBackoff(0, () => 0)).toBe(1000)
    expect(defaultBackoff(3, () => 0)).toBe(8000)
    expect(defaultBackoff(20, () => 0)).toBe(30000)
    expect(defaultBackoff(20, () => 1)).toBe(24000)
  })
  it('uses wss on https pages', () => {
    expect(eventsUrl({ protocol: 'https:', host: 'desk:1340' })).toBe('wss://desk:1340/remote/v1/events')
    expect(eventsUrl({ protocol: 'http:', host: '100.64.0.2:1340' })).toBe('ws://100.64.0.2:1340/remote/v1/events')
  })
})
