import { describe, it, expect, vi, beforeEach } from 'vitest'

// `invoke` stands in for the agent-tools access_* commands.
const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

import { runAccessRequest, useAccessRequests } from '../accessRequests'

const PREPARED = {
  status: 'ok',
  display: 'D:\\projects\\notes',
  isDir: true,
  mode: 'read',
  requested: 'D:\\projects\\notes',
  resolvedDiffers: false,
}

function backend(overrides: Record<string, (args: any) => unknown> = {}) {
  invoke.mockImplementation((cmd: string, args: any) => {
    const name = cmd.replace('plugin:agent-tools|', '')
    if (overrides[name]) return Promise.resolve(overrides[name](args))
    switch (name) {
      case 'access_prepare':
        return Promise.resolve({ ...PREPARED, mode: args.accessMode })
      case 'access_grant':
        return Promise.resolve({
          id: 'acc-1',
          session: args.sessionId,
          path: args.path,
          display: args.path,
          isDir: true,
          mode: args.accessMode,
          reason: args.reason,
          grantedAt: 1,
          expiresAt: args.persistent ? null : 2,
          persistent: args.persistent,
        })
      default:
        return Promise.resolve(undefined)
    }
  })
}

const opts = { dataFolder: 'C:/data' }
const calls = (name: string) =>
  invoke.mock.calls.filter(([c]) => c === `plugin:agent-tools|${name}`)

/** Answer the head of the queue once it appears. */
async function answerNext(decision: 'session' | 'always' | 'deny') {
  await vi.waitFor(() => {
    expect(useAccessRequests.getState().queue.length).toBeGreaterThan(0)
  })
  const head = useAccessRequests.getState().queue[0]
  useAccessRequests.getState().answer(head.id, decision)
  return head
}

describe('runAccessRequest', () => {
  let detach: () => void
  beforeEach(() => {
    invoke.mockReset()
    backend()
    useAccessRequests.setState({ queue: [], presenters: 0 })
    detach = useAccessRequests.getState().attachPresenter()
  })

  it('shows the resolved scope, grants for the session on approval, and tells the model to retry', async () => {
    const run = runAccessRequest(
      { path: 'D:\\projects\\notes', reason: 'read the todo list' },
      't1',
      opts
    )
    const head = await answerNext('session')
    expect(head.prepared.display).toBe('D:\\projects\\notes')
    expect(head.reason).toBe('read the todo list')
    const out = JSON.parse(await run)
    expect(out.status).toBe('granted')
    expect(out.scope).toBe('this conversation')
    expect(out.next).toMatch(/Retry the call/)
    expect(calls('access_grant')[0][1]).toMatchObject({
      sessionId: 't1',
      accessMode: 'read',
      persistent: false,
      // What was shown, never the model's spelling.
      path: 'D:\\projects\\notes',
    })
  })

  it('keeps a grant only when the user explicitly chooses always', async () => {
    const run = runAccessRequest({ path: 'D:\\p', reason: 'r' }, 't1', opts)
    await answerNext('always')
    expect(JSON.parse(await run).scope).toBe('kept until revoked')
    expect(calls('access_grant')[0][1].persistent).toBe(true)
  })

  it('returns a structured denial that tells the model not to ask again', async () => {
    const run = runAccessRequest({ path: 'D:\\p', reason: 'r' }, 't1', opts)
    await answerNext('deny')
    const out = JSON.parse(await run)
    expect(out.status).toBe('denied')
    expect(out.next).toMatch(/Do not request this path again/)
    expect(out.next).toMatch(/paste or attach/)
    expect(calls('access_grant')).toHaveLength(0)
    expect(calls('access_record_decision')[0][1].decision).toBe('denied')
  })

  it('does not prompt for a path the backend refuses', async () => {
    backend({
      access_prepare: () => ({
        status: 'refused',
        code: 'home_directory',
        message: 'too broad',
        modelResult: '{"status":"refused","code":"home_directory"}',
      }),
    })
    const out = JSON.parse(
      await runAccessRequest({ path: 'C:\\Users\\me', reason: 'r' }, 't1', opts)
    )
    expect(out).toEqual({ status: 'refused', code: 'home_directory' })
    expect(useAccessRequests.getState().queue).toHaveLength(0)
    expect(calls('access_grant')).toHaveLength(0)
  })

  it('asks for write only when the model asks for write, as its own request', async () => {
    const run = runAccessRequest(
      { path: 'D:\\p', reason: 'fix typo', access_mode: 'write' },
      't1',
      opts
    )
    const head = await answerNext('session')
    expect(head.prepared.mode).toBe('write')
    await run
    expect(calls('access_prepare')[0][1].accessMode).toBe('write')
    expect(calls('access_grant')[0][1].accessMode).toBe('write')
  })

  it('refuses an unknown mode and a missing reason without prompting', async () => {
    const bad = JSON.parse(
      await runAccessRequest({ path: 'D:\\p', reason: 'r', access_mode: 'admin' }, 't1', opts)
    )
    expect(bad.code).toBe('invalid_mode')
    const noReason = JSON.parse(await runAccessRequest({ path: 'D:\\p' }, 't1', opts))
    expect(noReason.code).toBe('missing_reason')
    expect(calls('access_prepare')).toHaveLength(0)
  })

  it('answers unavailable at once when no prompt can be shown', async () => {
    detach()
    const out = JSON.parse(
      await runAccessRequest({ path: 'D:\\p', reason: 'r' }, 't1', opts)
    )
    expect(out.status).toBe('unavailable')
    expect(out.next).toMatch(/Do not retry/)
    expect(calls('access_grant')).toHaveLength(0)
  })

  it('withdraws the prompt when the run stops', async () => {
    const ac = new AbortController()
    const run = runAccessRequest({ path: 'D:\\p', reason: 'r' }, 't1', {
      ...opts,
      signal: ac.signal,
    })
    await vi.waitFor(() =>
      expect(useAccessRequests.getState().queue).toHaveLength(1)
    )
    ac.abort()
    expect(JSON.parse(await run).status).toBe('cancelled')
    expect(useAccessRequests.getState().queue).toHaveLength(0)
    expect(calls('access_grant')).toHaveLength(0)
  })

  it('queues simultaneous requests and answers each one separately', async () => {
    const a = runAccessRequest({ path: 'D:\\a', reason: 'a' }, 't1', opts)
    const b = runAccessRequest({ path: 'D:\\b', reason: 'b' }, 't2', opts)
    await vi.waitFor(() =>
      expect(useAccessRequests.getState().queue).toHaveLength(2)
    )
    const [first, second] = useAccessRequests.getState().queue
    // Answering the second first must not touch the first.
    useAccessRequests.getState().answer(second.id, 'deny')
    expect(JSON.parse(await b).status).toBe('denied')
    expect(useAccessRequests.getState().queue).toEqual([first])
    useAccessRequests.getState().answer(first.id, 'session')
    expect(JSON.parse(await a).status).toBe('granted')
    expect(calls('access_grant')).toHaveLength(1)
    expect(calls('access_grant')[0][1].sessionId).toBe('t1')
  })

  it('releases waiting requests when the last prompt surface goes away', async () => {
    const run = runAccessRequest({ path: 'D:\\p', reason: 'r' }, 't1', opts)
    await vi.waitFor(() =>
      expect(useAccessRequests.getState().queue).toHaveLength(1)
    )
    detach()
    expect(JSON.parse(await run).status).toBe('cancelled')
  })
})
