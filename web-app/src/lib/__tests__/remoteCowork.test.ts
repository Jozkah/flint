import { describe, it, expect, beforeEach, vi } from 'vitest'
import { abortRun } from '@/lib/coworkRunner'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  allowedRemoteModes,
  isRemoteSession,
  loadRemoteTranscript,
  mergeRemoteRows,
  remoteSessionTitle,
  sendRemoteTurn,
  serverPageMode,
  setRemoteMode,
  startRemoteSession,
} from '../remoteCowork'
import { SseDecoder, subscribeRun, type LiveEnvelope } from '../remoteRunner'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))

const SID = '11111111-1111-4111-8111-111111111111'

const env = (seq: number, kind: string, payload: Record<string, unknown> = {}): LiveEnvelope => ({
  seq,
  source: 'live',
  kind,
  at: 0,
  payload,
})
const stream = (seq: number, payload: Record<string, unknown>) => env(seq, 'stream', payload)

const frame = (e: LiveEnvelope) => `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`

/** A response whose body the test writes to and closes. */
function openStream() {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await tick(5)
  }
}

beforeEach(() => {
  useCoworkSessions.setState({ sessions: [], currentId: null })
  useCoworkRun.setState({ liveTurns: {}, runs: {}, outcomes: {}, pendingAsks: {}, usage: {} })
  useToolApprovalRequests.setState({ pending: {}, queued: {} })
  useMessageQueue.setState({ queues: {} })
})

describe('SseDecoder', () => {
  it('holds a record split across chunks and skips heartbeats', () => {
    const d = new SseDecoder()
    expect(d.feed(': live\n\nid: 1\ndata: {"a":')).toEqual([])
    const out = d.feed('1}\n\n: keepalive\n\nevent: gap\ndata: {"from":5}\n\n')
    expect(out).toEqual([
      { event: 'message', id: '1', data: '{"a":1}' },
      { event: 'gap', id: null, data: '{"from":5}' },
    ])
  })
})

describe('subscribeRun', () => {
  it('resumes from the last seq after a dropped connection and reports gaps', async () => {
    const urls: string[] = []
    const first = openStream()
    const second = openStream()
    const queue = [first, second]
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return queue.shift()!.response
    })
    const got: number[] = []
    let gap: unknown = null
    const abort = new AbortController()
    const done = subscribeRun(SID, {
      after: 0,
      signal: abort.signal,
      fetchImpl,
      backoffMs: [1],
      onEvents: (events) => got.push(...events.map((e) => e.seq)),
      onGap: (g) => (gap = g),
    })
    first.write(': live\n\nevent: gap\ndata: {"from":4,"after":1}\n\n')
    first.write(frame(env(1, 'turn.started')) + frame(env(2, 'stream', { type: 'token', text: 'a' })))
    await until(() => got.length === 2)
    first.close()
    await until(() => urls.length === 2)
    expect(urls[1]).toContain('after=2')
    second.write(frame(env(2, 'stream', { type: 'token' })) + frame(env(3, 'turn.completed')))
    await until(() => got.length === 3)
    expect(got).toEqual([1, 2, 3])
    expect(gap).toEqual({ from: 4, after: 1 })
    abort.abort()
    second.close()
    await done
  })

  it('does not retry a session the server no longer holds', async () => {
    const fetchImpl = vi.fn(async () => new Response('that session is not running', { status: 404 }))
    await expect(
      subscribeRun(SID, { onEvents: () => {}, fetchImpl, backoffMs: [1] })
    ).rejects.toThrow(/not running/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('remote sessions in the Cowork stores', () => {
  const ready = {
    agent: true,
    runsSessions: true,
    enforces: true,
    roots: ['/srv'],
    maxSessions: 4,
    allowBypass: false,
    allowAlways: false,
    missing: [],
    parityGaps: [],
  }

  it('is created only while the server says it runs sessions', async () => {
    const refusing = async () => json({ ...ready, runsSessions: false, missing: ['install bubblewrap'] })
    await expect(startRemoteSession({ folder: '/srv/app' }, refusing)).rejects.toThrow(/bubblewrap/)
    expect(useCoworkSessions.getState().sessions).toHaveLength(0)

    const calls: string[] = []
    const fetchImpl = async (url: string) => {
      calls.push(url)
      if (url.endsWith('agent_server_info')) return json(ready)
      return json({ id: SID, folder: '/srv/app', model: 'm', access: 'ask', status: 'idle', lastSeq: 0 })
    }
    expect(await startRemoteSession({ folder: '/srv/app' }, fetchImpl)).toBe(SID)
    const session = useCoworkSessions.getState().sessions[0]
    expect(session.remote).toBe(true)
    expect(isRemoteSession(SID)).toBe(true)
    expect(useCoworkSessions.getState().currentId).toBe(SID)
  })

  it('sends the browser-selected model with a new session, or the one asked for', async () => {
    useModelProvider.setState({
      selectedProvider: 'v100',
      selectedModel: { id: 'qwen-coder' } as never,
    })
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.endsWith('agent_server_info')) return json(ready)
      bodies.push(JSON.parse(String(init?.body ?? '{}')))
      return json({ id: SID, folder: '/srv/app', model: 'qwen-coder', access: 'ask', status: 'idle', lastSeq: 0 })
    }
    await startRemoteSession({ folder: '/srv/app' }, fetchImpl)
    expect(bodies[0].model).toBe('qwen-coder')
    expect(useCoworkSessions.getState().sessions[0].remoteModel).toBe('qwen-coder')
    await startRemoteSession({ folder: '/srv/app', model: 'other' }, fetchImpl)
    expect(bodies[1].model).toBe('other')
    // A local engine's model is not one the server runs: left to its default.
    useModelProvider.setState({ selectedProvider: 'llamacpp', selectedModel: { id: 'local' } as never })
    await startRemoteSession({ folder: '/srv/app' }, fetchImpl)
    expect(bodies[2]).not.toHaveProperty('model')
  })

  it('keeps the server status and model of each server session', () => {
    mergeRemoteRows([
      { id: SID, title: 'S', folder: '/srv/a', mode: null, model: 'm1', updated: 5, status: 'running', campaign: null },
    ])
    let row = useCoworkSessions.getState().sessions.find((s) => s.id === SID)!
    expect(row.remoteStatus).toBe('running')
    expect(row.remoteModel).toBe('m1')
    mergeRemoteRows([
      { id: SID, title: 'S', folder: '/srv/a', mode: null, model: 'm2', updated: 6, status: 'awaiting_approval', campaign: null },
    ])
    row = useCoworkSessions.getState().sessions.find((s) => s.id === SID)!
    expect(row.remoteStatus).toBe('awaiting_approval')
    expect(row.remoteModel).toBe('m2')
    // An unnamed server session reports its id as its title: kept readable.
    mergeRemoteRows([
      { id: SID, title: SID, folder: '/srv/a', mode: null, model: 'm2', updated: 7, status: 'idle', campaign: null },
    ])
    expect(useCoworkSessions.getState().sessions.find((s) => s.id === SID)!.title).toBe('S')
  })

  it('mirrors a server list without touching local sessions', () => {
    useCoworkSessions.setState({
      sessions: [
        { id: 'local', title: 'Local', folder: null, turns: [], messages: [], updated: 1 },
        { id: 'gone', title: 'Old', folder: '/x', turns: [], messages: [], updated: 1, remote: true },
      ],
      currentId: 'local',
    })
    mergeRemoteRows([
      { id: SID, title: 'Server one', folder: '/srv/a', mode: null, model: null, updated: 5, status: 'idle', campaign: null },
    ])
    const ids = useCoworkSessions.getState().sessions.map((s) => s.id)
    expect(ids).toContain('local')
    expect(ids).toContain(SID)
    expect(ids).not.toContain('gone')
  })

  it('refuses a local session and never touches the network for it', async () => {
    useCoworkSessions.setState({
      sessions: [{ id: 'local', title: 'L', folder: null, turns: [], messages: [], updated: 1 }],
    })
    const fetchImpl = vi.fn()
    await expect(sendRemoteTurn('local', 'hi', { fetchImpl })).rejects.toThrow(/not a server session/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('runs a turn: tokens and tools live, a prompt raised and answered over the wire, the transcript committed', async () => {
    useCoworkSessions.setState({
      sessions: [
        { id: SID, title: 'S', folder: '/srv/app', turns: [], messages: [], updated: 1, remote: true },
      ],
      currentId: SID,
    })
    const events = openStream()
    const posted: Array<{ command: string; body: Record<string, unknown> }> = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.includes('/events')) return events.response
      const command = url.split('/').pop()!
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      posted.push({ command, body })
      if (command === 'agent_run_start') return json({ turnId: 't1', after: 0 })
      if (command === 'agent_run_get') {
        return json({
          id: SID,
          title: 'S',
          folder: '/srv/app',
          turns: [
            { role: 'user', content: 'do it' },
            { role: 'tool', content: '', callId: 'c1', name: 'write', args: {}, status: 'done', result: 'ok' },
            { role: 'assistant', content: 'done' },
          ],
        })
      }
      return json({})
    }
    await sendRemoteTurn(SID, 'do it', { fetchImpl, steerEveryMs: 20 })
    expect(posted[0]).toEqual({ command: 'agent_run_start', body: { id: SID, input: 'do it' } })
    expect(useCoworkRun.getState().runs[SID]).toBeTruthy()

    events.write(
      frame(env(1, 'turn.started', { turnId: 't1' })) +
        frame(stream(2, { type: 'token', text: 'Let me ' })) +
        frame(stream(3, { type: 'token', text: 'write it.' })) +
        frame(stream(4, { type: 'tool_call', id: 'c1', name: 'write', args: { path: 'a.txt' } })) +
        frame(
          stream(5, {
            type: 'permission_request',
            request_id: 'perm-7',
            tool_name: 'write',
            capability: 'write',
            path: 'a.txt',
            diff: '+hello',
            prompt_kind: 'write',
            offers_always: false,
          })
        )
    )
    await until(() => !!useToolApprovalRequests.getState().pending['perm-7'])
    const live = useCoworkRun.getState().liveTurns[SID]
    expect(live[0]).toMatchObject({ role: 'user', content: 'do it' })
    expect(live.find((t) => t.role === 'assistant')?.content).toBe('Let me write it.')
    expect(live.find((t) => t.role === 'tool')).toMatchObject({ callId: 'c1', name: 'write' })
    const prompt = useToolApprovalRequests.getState().pending['perm-7']
    // Shown on its own, never as something this window may grant for good.
    expect(prompt).toMatchObject({ origin: 'server', alwaysAsk: true, preview: '+hello' })
    expect(prompt.input).toBeUndefined()

    useToolApprovalRequests.getState().resolveApproval('perm-7', 'allow-always')
    await until(() => posted.some((p) => p.command === 'agent_run_approve'))
    // The server did not offer a standing approval, so the answer is once.
    expect(posted.find((p) => p.command === 'agent_run_approve')!.body).toEqual({
      id: SID,
      requestId: 'perm-7',
      decision: 'allow_once',
    })

    events.write(
      frame(stream(6, { type: 'tool_result', id: 'c1', content: 'ok', is_error: false })) +
        frame(stream(7, { type: 'done', stop_reason: 'stop', usage: null })) +
        frame(env(8, 'turn.completed', { turnId: 't1', stopReason: 'completed', error: null }))
    )
    await until(() => !useCoworkRun.getState().runs[SID])
    const committed = useCoworkSessions.getState().sessions.find((s) => s.id === SID)!
    expect(committed.turns.map((t) => t.role)).toEqual(['user', 'tool', 'assistant'])
    expect(useCoworkRun.getState().outcomes[SID]).toBeUndefined()
    events.close()
  })

  it('stops through the same Stop control a local run uses', async () => {
    useCoworkSessions.setState({
      sessions: [{ id: SID, title: 'S', folder: '/srv/app', turns: [], messages: [], updated: 1, remote: true }],
    })
    const events = openStream()
    const posted: string[] = []
    const fetchImpl = async (url: string) => {
      if (url.includes('/events')) return events.response
      const command = url.split('/').pop()!
      posted.push(command)
      if (command === 'agent_run_start') return json({ turnId: 't1', after: 0 })
      if (command === 'agent_run_get') return json({ id: SID, title: 'S', folder: '/srv/app', turns: [] })
      return json({})
    }
    await sendRemoteTurn(SID, 'long job', { fetchImpl, steerEveryMs: 1000 })
    abortRun(SID)
    await until(() => posted.includes('agent_run_interrupt'))
    events.write(frame(env(1, 'turn.completed', { turnId: 't1', stopReason: 'interrupted', error: null })))
    await until(() => !useCoworkRun.getState().runs[SID])
    expect(useCoworkRun.getState().outcomes[SID]).toEqual({ stoppedBy: 'aborted' })
    events.close()
  })

  it('forwards what the user steers with to the server', async () => {
    useCoworkSessions.setState({
      sessions: [{ id: SID, title: 'S', folder: '/srv/app', turns: [], messages: [], updated: 1, remote: true }],
    })
    const events = openStream()
    const posted: Array<{ command: string; body: Record<string, unknown> }> = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.includes('/events')) return events.response
      const command = url.split('/').pop()!
      posted.push({ command, body: init?.body ? JSON.parse(String(init.body)) : {} })
      if (command === 'agent_run_start') return json({ turnId: 't1', after: 0 })
      if (command === 'agent_run_get') return json({ id: SID, title: 'S', folder: '/srv/app', turns: [] })
      return json({})
    }
    await sendRemoteTurn(SID, 'go', { fetchImpl, steerEveryMs: 10 })
    useMessageQueue.getState().enqueue(SID, { id: 'q1', text: 'also check b', createdAt: 1, steer: true })
    await until(() => posted.some((p) => p.command === 'agent_run_steer'))
    expect(posted.find((p) => p.command === 'agent_run_steer')!.body).toEqual({ id: SID, text: 'also check b' })
    expect(useCoworkRun.getState().liveTurns[SID].some((t) => t.steered && t.content === 'also check b')).toBe(true)
    events.write(frame(env(1, 'turn.completed', { turnId: 't1', stopReason: 'completed', error: null })))
    await until(() => !useCoworkRun.getState().runs[SID])
    events.close()
  })

  it('records a failed start as the run outcome', async () => {
    useCoworkSessions.setState({
      sessions: [{ id: SID, title: 'S', folder: '/srv/app', turns: [], messages: [], updated: 1, remote: true }],
    })
    const fetchImpl = async (url: string) => {
      if (url.includes('/events')) return new Response('no', { status: 404 })
      const command = url.split('/').pop()!
      if (command === 'agent_run_start') return new Response('this server runs at most 1 sessions', { status: 429 })
      return json({ id: SID, title: 'S', folder: '/srv/app', turns: [] })
    }
    await sendRemoteTurn(SID, 'go', { fetchImpl })
    await until(() => !useCoworkRun.getState().runs[SID])
    expect(useCoworkRun.getState().outcomes[SID]).toMatchObject({ stoppedBy: 'error' })
    expect(useCoworkRun.getState().outcomes[SID].errorText).toMatch(/at most 1/)
  })
})

describe('server session mode and title (round 5 W12-W14)', () => {
  const remoteRow = (extra: Record<string, unknown> = {}) => ({
    id: SID,
    title: 'S',
    folder: '/srv/app',
    turns: [],
    messages: [],
    updated: 1,
    remote: true,
    ...extra,
  })

  it.each([
    ['review', 'read'],
    ['ask', 'ask'],
    ['auto', 'auto'],
  ] as const)('sends %s to the server as access %s and shows what it answered', async (mode, access) => {
    useCoworkSessions.setState({ sessions: [remoteRow({ remoteAccess: 'ask' }) as never] })
    const bodies: Array<[string, Record<string, unknown>]> = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      bodies.push([url.split('/').pop()!, JSON.parse(String(init?.body ?? '{}'))])
      return json({ access })
    }
    await setRemoteMode(SID, mode, fetchImpl)
    expect(bodies).toEqual([['agent_run_set_mode', { id: SID, access }]])
    const row = useCoworkSessions.getState().sessions[0]
    expect(row.remoteAccess).toBe(access)
    expect(serverPageMode(row)).toBe(mode)
  })

  it('syncs a mode picked before the first message before the run starts', async () => {
    useCoworkSessions.setState({
      sessions: [remoteRow({ mode: 'review', remoteAccess: 'ask' }) as never],
    })
    const commands: string[] = []
    let sentAccess: unknown
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.includes('/events')) return new Response('no', { status: 404 })
      const command = url.split('/').pop()!
      commands.push(command)
      if (command === 'agent_run_set_mode') {
        sentAccess = JSON.parse(String(init?.body)).access
        return json({ access: 'read' })
      }
      if (command === 'agent_run_start') return new Response('stop here', { status: 429 })
      return json({ id: SID, title: 'S', folder: '/srv/app', turns: [] })
    }
    await sendRemoteTurn(SID, 'go', { fetchImpl })
    await until(() => !useCoworkRun.getState().runs[SID])
    expect(sentAccess).toBe('read')
    expect(commands.indexOf('agent_run_set_mode')).toBeGreaterThanOrEqual(0)
    expect(commands.indexOf('agent_run_set_mode')).toBeLessThan(commands.indexOf('agent_run_start'))
    expect(useCoworkSessions.getState().sessions[0].remoteAccess).toBe('read')
  })

  it('does not start the run when the server refuses the mode', async () => {
    useCoworkSessions.setState({ sessions: [remoteRow({ mode: 'auto', remoteAccess: 'ask' }) as never] })
    const commands: string[] = []
    const fetchImpl = async (url: string) => {
      const command = url.split('/').pop()!
      commands.push(command)
      if (command === 'agent_run_set_mode') return new Response('start it with --agent-allow-bypass', { status: 403 })
      return json({ turnId: 't', after: 0 })
    }
    await sendRemoteTurn(SID, 'go', { fetchImpl })
    await until(() => !useCoworkRun.getState().runs[SID])
    expect(commands).not.toContain('agent_run_start')
    expect(useCoworkRun.getState().outcomes[SID]).toMatchObject({ stoppedBy: 'error' })
  })

  it('shows the server access, defaulting to ask, never auto', () => {
    expect(serverPageMode(undefined)).toBe('ask')
    expect(serverPageMode({ remote: true })).toBe('ask')
    expect(serverPageMode({ remote: true, remoteAccess: 'read', mode: 'auto' })).toBe('review')
    mergeRemoteRows([
      { id: SID, title: 'S', folder: '/srv/a', mode: null, model: null, updated: 5, status: 'idle', campaign: null, access: 'read' },
    ])
    expect(serverPageMode(useCoworkSessions.getState().sessions[0])).toBe('review')
  })

  it('offers auto and bypass only when the server allows them', () => {
    expect(allowedRemoteModes({ allowBypass: false })).toEqual(['review', 'ask'])
    expect(allowedRemoteModes(null)).toEqual(['review', 'ask'])
    expect(allowedRemoteModes({ allowBypass: true })).toEqual(['review', 'ask', 'auto', 'bypass'])
  })

  it('passes the chosen access when a session is created and records it', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.endsWith('agent_server_info')) return json({ agent: true, runsSessions: true, missing: [] })
      bodies.push(JSON.parse(String(init?.body ?? '{}')))
      return json({ id: SID, folder: '/srv/app', model: 'm', access: 'read', status: 'idle', lastSeq: 0 })
    }
    await startRemoteSession({ folder: '/srv/app', access: 'read' }, fetchImpl)
    expect(bodies[0].access).toBe('read')
    const row = useCoworkSessions.getState().sessions[0]
    expect(row.remoteAccess).toBe('read')
    expect(serverPageMode(row)).toBe('review')
  })

  it('never titles a session with its bare id', async () => {
    mergeRemoteRows([
      { id: SID, title: SID, folder: '/srv/a', mode: null, model: null, updated: 5, status: 'idle', campaign: null },
    ])
    expect(useCoworkSessions.getState().sessions[0].title).toBe('New session')
    const fetchImpl = async () =>
      json({ id: SID, title: SID, folder: '/srv/a', turns: [{ role: 'user', content: 'Fix the login bug\nplease' }] })
    await loadRemoteTranscript(SID, fetchImpl)
    expect(useCoworkSessions.getState().sessions[0].title).toBe('Fix the login bug')
    expect(remoteSessionTitle(SID, 'Named', [])).toBe('Named')
    expect(remoteSessionTitle(SID, '', [])).toBe('New session')
  })
})
