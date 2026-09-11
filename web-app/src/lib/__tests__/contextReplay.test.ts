/**
 * Context replay, the renderer's half (AH-079). The backend owns the record
 * and the payload; these tests stand in for it with an in-memory store that
 * keeps the same rules (first ending wins, refusals are typed) and check what
 * this side sends, what it reads back, and how each ending is reported.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: { getState: () => ({ getProviderByName: () => undefined }) },
}))

import {
  cancelReplay,
  isReplaying,
  listReplays,
  readReply,
  startReplay,
  type ReplayDeps,
  type ReplayView,
} from '../contextReplay'

const PAYLOAD = {
  model: 'smoke-model',
  stream: true,
  messages: [
    { role: 'system', content: 'You are Jan.' },
    { role: 'user', content: 'fix the bug' },
  ],
  tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }],
}

type Snap = { provider: string; model: string; redacted?: boolean }

function backend(snaps: Record<string, Snap>) {
  const records: ReplayView[] = []
  let n = 0
  const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'agent_replay_begin') {
      const snap = snaps[args.snapshotId as string]
      if (!snap) throw { kind: 'not-found', message: 'that snapshot is no longer on disk' }
      if (snap.redacted) {
        records.push(view(`r${++n}`, args, snap, 'refused', { kind: 'redacted', message: '1 field(s) were redacted' }))
        throw { kind: 'redacted', message: '1 field(s) were redacted' }
      }
      const record = view(`r${++n}`, args, snap, 'running', null)
      records.push(record)
      return { record, payload: structuredClone(PAYLOAD) }
    }
    if (cmd === 'agent_replay_settle') {
      const r = records.find((x) => x.id === args.replayId)!
      if (r.status !== 'running') return r
      const o = args.outcome as Record<string, unknown>
      Object.assign(r, {
        status: o.status,
        state: o.status,
        text: o.text ?? '',
        finishReason: o.finishReason ?? null,
        toolCalls: o.toolCalls ?? [],
        error:
          o.status === 'completed'
            ? null
            : { kind: o.errorKind ?? 'provider-error', message: o.errorMessage ?? '' },
      })
      return r
    }
    if (cmd === 'agent_replays_list') {
      return records.filter((r) => r.snapshotId === args.snapshotId).slice().reverse()
    }
    throw new Error(`unexpected ${cmd}`)
  })
  return { invoke, records }
}

function view(
  id: string,
  args: Record<string, unknown>,
  snap: Snap,
  status: ReplayView['status'],
  error: ReplayView['error']
): ReplayView {
  return {
    id,
    session: args.session as string,
    snapshotId: args.snapshotId as string,
    snapshotHash: 'fnv1a64:1',
    provider: snap.provider,
    model: snap.model,
    status,
    state: status,
    startedAt: 'now',
    endedAt: null,
    replaySnapshotId: null,
    matched: null,
    text: '',
    truncated: false,
    finishReason: null,
    toolCalls: [],
    usage: null,
    error,
  }
}

const sse = (...events: unknown[]) =>
  events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')

const delta = (d: object, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
})

function streamed(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  })
}

function deps(b: ReturnType<typeof backend>, fetch: ReplayDeps['fetch'], over: Partial<ReplayDeps> = {}): ReplayDeps {
  return {
    invoke: b.invoke as unknown as ReplayDeps['invoke'],
    fetch,
    provider: (name) =>
      name === 'smoke'
        ? { provider: 'smoke', base_url: 'http://127.0.0.1:9/v1/', api_key: 'k-smoke' }
        : name === 'claude'
          ? { provider: 'claude', api_type: 'anthropic', base_url: 'https://x' }
          : undefined,
    localSession: async () => null,
    ...over,
  }
}

describe('context replay', () => {
  let b: ReturnType<typeof backend>
  beforeEach(() => {
    b = backend({
      a: { provider: 'smoke', model: 'smoke-model' },
      secret: { provider: 'smoke', model: 'smoke-model', redacted: true },
      gone: { provider: 'removed', model: 'x' },
      anth: { provider: 'claude', model: 'claude-x' },
    })
  })

  it('sends the stored request unchanged and records what came back, running no tools', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      streamed(
        sse(
          delta({ role: 'assistant', content: '' }),
          delta({ content: 'Fixed ' }),
          delta({ content: 'it.' }),
          delta({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'bash', arguments: '{}' } }] }),
          delta({}, 'tool_calls'),
          '[DONE]'
        )
      )
    )
    const outcome = await startReplay('s1', 'a', deps(b, fetch))
    expect(outcome.ok).toBe(true)

    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:9/v1/chat/completions')
    expect(JSON.parse(init!.body as string)).toEqual(PAYLOAD)
    const headers = init!.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer k-smoke')
    expect(headers['x-jan-session']).toBe('s1')
    expect(headers['x-jan-agent']).toBe('replay')

    const [done] = await listReplays('s1', 'a', deps(b, fetch))
    expect(done.state).toBe('completed')
    expect(done.text).toBe('Fixed it.')
    expect(done.finishReason).toBe('tool_calls')
    expect(done.toolCalls).toEqual(['bash'])
    expect(isReplaying(done.id)).toBe(false)
  })

  it('a redacted snapshot is refused by the backend and nothing is sent', async () => {
    const fetch = vi.fn()
    const outcome = await startReplay('s1', 'secret', deps(b, fetch))
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'redacted' } })
    expect(fetch).not.toHaveBeenCalled()
    expect((await listReplays('s1', 'secret', deps(b, fetch)))[0].state).toBe('refused')
  })

  it('a provider that is gone, or speaks another wire format, is a typed refusal', async () => {
    const fetch = vi.fn()
    expect(await startReplay('s1', 'gone', deps(b, fetch))).toMatchObject({
      ok: false,
      error: { kind: 'provider-gone' },
    })
    expect(await startReplay('s1', 'anth', deps(b, fetch))).toMatchObject({
      ok: false,
      error: { kind: 'provider-unsupported' },
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(b.records.map((r) => r.state)).toEqual(['refused', 'refused'])
  })

  it('a local model that is not running is refused rather than started', async () => {
    const b2 = backend({ l: { provider: 'llamacpp', model: 'qwen' } })
    const fetch = vi.fn()
    const localSession = vi.fn(async () => null)
    const d = deps(b2, fetch, {
      provider: () => ({ provider: 'llamacpp' }),
      localSession,
    })
    expect(await startReplay('s1', 'l', d)).toMatchObject({
      ok: false,
      error: { kind: 'model-not-running' },
    })
    expect(localSession).toHaveBeenCalledWith('llamacpp', 'qwen')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a provider error and a cut-off reply are failures, never completions', async () => {
    const failing = vi.fn(async () => new Response('{"error":"no such model"}', { status: 404 }))
    expect(await startReplay('s1', 'a', deps(b, failing))).toMatchObject({
      ok: false,
      error: { kind: 'provider-error' },
    })
    expect(b.records[0].error!.message).toContain('HTTP 404')

    const cut = vi.fn(async () => streamed(sse(delta({ content: 'half' }))))
    expect(await startReplay('s1', 'a', deps(b, cut))).toMatchObject({
      ok: false,
      error: { kind: 'stream-cut-off' },
    })
    expect(b.records[1].text).toBe('half')
  })

  it('a replay stopped part-way is recorded as stopped and holds nothing open', async () => {
    let aborted = false
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse(delta({ content: 'working ' }))))
          init!.signal!.addEventListener('abort', () => {
            aborted = true
            c.error(new DOMException('aborted', 'AbortError'))
          })
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    })
    const running = startReplay('s1', 'a', deps(b, fetch))
    await vi.waitFor(() => expect(isReplaying('r1')).toBe(true))
    cancelReplay('r1')
    const outcome = await running
    expect(aborted).toBe(true)
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'abandoned' } })
    expect(b.records[0].state).toBe('cancelled')
    expect(isReplaying('r1')).toBe(false)
  })

  it('a replay whose window went away is recorded as abandoned when next listed', async () => {
    b.records.push(view('r-old', { session: 's1', snapshotId: 'a' }, { provider: 'smoke', model: 'm' }, 'running', null))
    const [shown] = await listReplays('s1', 'a', deps(b, vi.fn()))
    expect(shown.state).toBe('cancelled')
    expect(shown.error).toMatchObject({ kind: 'abandoned' })
  })
})

describe('readReply', () => {
  it('reads a whole (non-streamed) reply', async () => {
    const r = await readReply(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hi', tool_calls: [{ function: { name: 'read' } }] }, finish_reason: 'stop' }],
          usage: { total_tokens: 3 },
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    )
    expect(r).toEqual({ text: 'hi', finishReason: 'stop', toolCalls: ['read'], usage: { total_tokens: 3 }, complete: true })
  })

  it('reads a stream split at arbitrary points', async () => {
    const text = sse(delta({ content: 'a' }), delta({ content: 'b' }, 'stop'), '[DONE]')
    const bytes = new TextEncoder().encode(text)
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7))
        c.close()
      },
    })
    const r = await readReply(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    expect(r.text).toBe('ab')
    expect(r.complete).toBe(true)
  })
})
