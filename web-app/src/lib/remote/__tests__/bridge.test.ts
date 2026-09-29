import { describe, it, expect, vi } from 'vitest'
import { create } from 'zustand'
import { dispatchRemoteRpc, RemoteRpcError, type RemoteHandlers } from '../bridge'
import { createRemoteHandlers, pageOf, type RemoteSources } from '../handlers'
import { diffIds, watchIds } from '../events'
import type { RemoteRpcRequest } from '../protocol'

vi.mock('@/hooks/useAppState', () => ({ useAppState: {} }))
vi.mock('@/hooks/useCoworkRun', () => ({ useCoworkRun: {} }))
vi.mock('@/hooks/useToolApprovalRequests', () => ({
  useToolApprovalRequests: {},
  allApprovalRequests: () => [],
}))
vi.mock('@/lib/rooms/store', () => ({ useRoomsStore: {} }))
vi.mock('../mobileMutations', () => ({
  handleMobileMutation: vi.fn(async (raw: Record<string, unknown>) => {
    if (raw.mobileOp === 'room.create') return { ok: true, id: 'new-room' }
    if (raw.mobileOp === 'room.update') return { ok: true, id: String(raw.id) }
    if (raw.mobileOp === 'room.delete') return { ok: true }
    return null
  }),
}))

const device = { id: 'd1', name: 'Pixel' }
const req = (method: string, params: unknown = {}): RemoteRpcRequest => ({
  id: 'r1',
  method,
  params,
  device,
})

function sources(over: Partial<RemoteSources> = {}): RemoteSources {
  return {
    chats: () => [
      { id: 'c1', title: 'Old chat', updated: 1_700_000_000, project: 'Acme' },
      { id: 'c2', title: 'Busy chat', updated: 1_700_000_500 },
    ],
    coworkSessions: () => [
      { id: 'w1', title: 'Fix radar', updated: 1_700_000_200_000, folder: '/home/u/acme-weather' },
    ],
    rooms: async () => [{ id: 'r1', title: 'Release', status: 'awaiting-user', updatedAt: 1_700_000_100_000 }],
    running: () => ({ chat: new Set(['c2']), cowork: new Set(), room: new Set() }),
    approvals: () => [{ requestId: 'a1', threadId: 'w1' }],
    chatMessages: async (id) =>
      id === 'c1'
        ? Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, role: 'user' as const, text: `t${i}`, createdAt: i }))
        : [],
    coworkMessages: () => null,
    roomMessages: async () => [],
    providers: () => [
      { provider: 'llamacpp', local: true, models: [{ id: 'qwen', name: 'Qwen3 8B' }, { id: 'gemma' }] },
      { provider: 'anthropic', local: false, models: [{ id: 'claude' }] },
    ],
    loadedModels: async () => ['qwen'],
    roomDetail: async () => null,
    coworkDetail: () => null,
    approvalDetails: () => [],
    systemInfo: async () => { throw new Error('unused') },
    mcpServers: () => [],
    settings: async () => { throw new Error('unused') },
    appearance: () => ({ vars: { light: {}, dark: {} } }),
    ...over,
  }
}

describe('dispatchRemoteRpc', () => {
  const handlers = createRemoteHandlers(sources())

  it('answers an unknown method with an error, not a throw', async () => {
    expect(await dispatchRemoteRpc(req('nope'), handlers)).toEqual({
      error: { code: 'unknown_method', message: 'Unknown method nope' },
    })
    const r = await dispatchRemoteRpc(req('toString'), handlers)
    expect('error' in r && r.error.code).toBe('unknown_method')
  })

  it('stubs later-phase methods with not_implemented', async () => {
    for (const m of ['chat.send', 'approvals.respond', 'run.stop']) {
      const r = await dispatchRemoteRpc(req(m), handlers)
      expect('error' in r && r.error.code).toBe('not_implemented')
    }
  })

  it('turns handler failures into replies and hides internal errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = {
      ...handlers,
      status: () => { throw new Error('secret path /home/u') },
      'models.list': () => { throw new RemoteRpcError('bad_params', 'nope') },
    } as RemoteHandlers
    expect(await dispatchRemoteRpc(req('status'), failing)).toEqual({
      error: { code: 'internal', message: 'Flint could not do that' },
    })
    expect(await dispatchRemoteRpc(req('models.list'), failing)).toEqual({
      error: { code: 'bad_params', message: 'nope' },
    })
    spy.mockRestore()
  })

  it('passes the device to the handler', async () => {
    const seen = vi.fn(() => ({ modelsLoaded: 0, runs: [], approvalsWaiting: 0 }))
    await dispatchRemoteRpc(req('status'), { ...handlers, status: seen } as RemoteHandlers)
    expect(seen).toHaveBeenCalledWith({}, { device })
  })
})

describe('handlers', () => {
  const handlers = createRemoteHandlers(sources())
  const call = async (method: string, params: unknown = {}) => {
    const r = await dispatchRemoteRpc(req(method, params), handlers)
    if ('error' in r) throw new Error(r.error.message)
    return r.result as never
  }

  it('exposes first-class room create/update/delete mutations', async () => {
    expect(await call('room.create', {
      title: 'Review',
      objective: 'Pick an approach',
      mode: 'round-robin',
      participants: [
        { name: 'A', role: 'proposer', model: { id: 'qwen', provider: 'llamacpp' }, toolAccess: 'none' },
        { name: 'B', role: 'reviewer', model: { id: 'claude', provider: 'anthropic' }, toolAccess: 'none' },
      ],
    })).toEqual({ ok: true, id: 'new-room' })
    expect(await call('room.update', { id: 'new-room', patch: { mode: 'user-selected' } })).toEqual({ ok: true, id: 'new-room' })
    expect(await call('room.delete', { id: 'new-room' })).toEqual({ ok: true })
  })

  it('sessions.list merges kinds, newest first, with status and group', async () => {
    const { sessions } = await call('sessions.list')
    expect(sessions).toEqual([
      { id: 'c2', kind: 'chat', title: 'Busy chat', status: 'running', updatedAt: 1_700_000_500_000 },
      { id: 'w1', kind: 'cowork', title: 'Fix radar', status: 'waiting', updatedAt: 1_700_000_200_000, group: 'acme-weather' },
      { id: 'r1', kind: 'room', title: 'Release', status: 'waiting', updatedAt: 1_700_000_100_000 },
      { id: 'c1', kind: 'chat', title: 'Old chat', status: 'idle', updatedAt: 1_700_000_000_000, group: 'Acme' },
    ])
  })

  it('sessions.list filters by kind and clamps the limit', async () => {
    const chats = await call('sessions.list', { kind: 'chat', limit: 1 })
    expect((chats as { sessions: unknown[] }).sessions).toHaveLength(1)
    const bogus = await call('sessions.list', { kind: 'bogus', limit: -5 })
    expect((bogus as { sessions: unknown[] }).sessions).toHaveLength(1)
  })

  it('thread.messages pages from the end', async () => {
    const last = await call('thread.messages', { id: 'c1', kind: 'chat', limit: 2 })
    expect(last).toMatchObject({ start: 3, total: 5 })
    expect((last as { messages: { id: string }[] }).messages.map((m) => m.id)).toEqual(['m3', 'm4'])
    const prev = await call('thread.messages', { id: 'c1', kind: 'chat', limit: 2, before: 3 })
    expect((prev as { messages: { id: string }[] }).messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('thread.messages validates params and reports missing sessions', async () => {
    const bad = await dispatchRemoteRpc(req('thread.messages', { kind: 'chat' }), handlers)
    expect('error' in bad && bad.error.code).toBe('bad_params')
    const missing = await dispatchRemoteRpc(req('thread.messages', { id: 'x', kind: 'cowork' }), handlers)
    expect('error' in missing && missing.error.code).toBe('not_found')
  })

  it('models.list marks local and loaded models', async () => {
    const { models } = await call('models.list')
    expect(models).toEqual([
      { id: 'qwen', name: 'Qwen3 8B', provider: 'llamacpp', local: true, loaded: true },
      { id: 'gemma', name: 'gemma', provider: 'llamacpp', local: true, loaded: false },
      { id: 'claude', name: 'claude', provider: 'anthropic', local: false, loaded: false },
    ])
  })

  it('status counts loaded models, runs and approvals', async () => {
    expect(await call('status')).toEqual({ modelsLoaded: 1, runs: [{ kind: 'chat', id: 'c2' }], approvalsWaiting: 1 })
  })

  it('pageOf clamps before to the range', () => {
    expect(pageOf([1, 2, 3], 99, 2)).toEqual({ items: [2, 3], start: 1, total: 3 })
    expect(pageOf([1, 2, 3], -1, 2)).toEqual({ items: [], start: 0, total: 3 })
  })
})

describe('event forwarding', () => {
  it('diffIds reports additions and removals', () => {
    expect(diffIds(new Set(['a', 'b']), new Set(['b', 'c']))).toEqual({ added: ['c'], removed: ['a'] })
  })

  it('watchIds fires only when the selected ids change', () => {
    const store = create<{ ids: string[]; other: number }>()(() => ({ ids: [], other: 0 }))
    const seen: unknown[] = []
    const stop = watchIds(store, (s) => new Set(s.ids), (d) => seen.push(d))
    store.setState({ other: 1 })
    store.setState({ ids: ['x'] })
    store.setState({ ids: [] })
    stop()
    store.setState({ ids: ['y'] })
    expect(seen).toEqual([
      { added: ['x'], removed: [] },
      { added: [], removed: ['x'] },
    ])
  })
})
