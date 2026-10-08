import { describe, it, expect, vi, beforeEach } from 'vitest'
import { accessPrompt, conflictPrompt, contextPrompt, domainPrompt } from '../prompts'
import { dispatchRemoteRpc, type RemoteHandlers } from '../bridge'
import { createActionHandlers, type RemoteActions } from '../actions'
import { createRemoteHandlers, type RemoteSources } from '../handlers'
import { appPrompts, respondAppPrompt } from '../appPrompts'
import { useAccessRequests } from '@/lib/accessRequests'
import { useBrowserAgentPrompt } from '@/hooks/useBrowserAgentPrompt'
import { useTeamConflictRequests } from '@/hooks/useTeamConflictRequests'
import { useContextSizeApproval } from '@/hooks/useModelContextApproval'
import { conflictKey, type PairConflict, type TeamTask } from '@/lib/coworkTeam'

const device = { id: 'd1', name: 'Pixel' }

const ACCESS = accessPrompt({
  id: 'access-1',
  threadId: 'w1',
  reason: 'The tests live there',
  origin: 'tester',
  prepared: { display: 'C:\\work\\other', isDir: true, mode: 'write' },
})

describe('prompt wording', () => {
  it('a folder outside the session: narrow answers only, no standing grant', () => {
    expect(ACCESS).toMatchObject({
      id: 'access:access-1',
      kind: 'access',
      threadId: 'w1',
      title: "Flint wants to change a folder outside this session's folder",
      detail: 'C:\\work\\other',
      body: 'The tests live there',
      origin: 'tester',
    })
    expect(ACCESS.actions.map((a) => a.id)).toEqual(['deny', 'session'])
  })

  it('a site for the assistant’s browser: once or this session, never "always"', () => {
    const p = domainPrompt({ id: 'domain-1', url: 'https://example.com/docs', host: 'example.com', tool: 'browser_open' })
    expect(p).toMatchObject({ id: 'domain:domain-1', kind: 'domain', detail: 'https://example.com/docs' })
    expect(p.threadId).toBeUndefined()
    expect(p.actions.map((a) => a.id)).toEqual(['deny', 'session', 'once'])
  })

  it('overlapping team tasks name the pairs and the files', () => {
    const p = conflictPrompt({
      sessionId: 'w1',
      callId: 'c1',
      conflicts: [{ tasks: ['api', 'ui'], overlaps: [{ paths: ['src/a.ts', 'src/a.ts'], note: '' }] }],
    })
    expect(p).toMatchObject({ id: 'conflict:w1:c1', threadId: 'w1', detail: 'api and ui: src/a.ts' })
    expect(p.actions.map((a) => a.id)).toEqual(['cancel', 'parallel', 'serialize'])
    expect(contextPrompt().actions.map((a) => a.id)).toEqual(['deny', 'context_shift', 'ctx_len'])
  })
})

describe('approvals.prompt', () => {
  const setup = (over: Partial<RemoteActions> = {}) => {
    const a = {
      permissions: vi.fn(async () => ({ approvals: true, alwaysAllow: false })),
      findPrompt: vi.fn((id: string) => (id === ACCESS.id ? ACCESS : null)),
      respondPrompt: vi.fn(() => true),
      ...over,
    } as unknown as RemoteActions
    const handlers = createActionHandlers(a) as unknown as RemoteHandlers
    const call = (params: unknown) => dispatchRemoteRpc({ id: 'x', method: 'approvals.prompt', params, device }, handlers)
    return { a, call }
  }

  it('answers with an action the prompt offers', async () => {
    const { a, call } = setup()
    expect(await call({ id: ACCESS.id, action: 'session' })).toEqual({ result: { status: 'answered' } })
    expect(a.respondPrompt).toHaveBeenCalledWith(ACCESS.id, 'session')
  })

  it('refuses an answer the prompt does not offer, such as a standing grant', async () => {
    const { a, call } = setup()
    expect(await call({ id: ACCESS.id, action: 'always' })).toMatchObject({ error: { code: 'bad_params' } })
    expect(await call({ id: ACCESS.id })).toMatchObject({ error: { code: 'bad_params' } })
    expect(a.respondPrompt).not.toHaveBeenCalled()
  })

  it('is off when approvals from phones are off', async () => {
    const { a, call } = setup({ permissions: vi.fn(async () => ({ approvals: false, alwaysAllow: false })) })
    expect(await call({ id: ACCESS.id, action: 'deny' })).toMatchObject({ error: { code: 'forbidden' } })
    expect(a.respondPrompt).not.toHaveBeenCalled()
  })

  it('says gone when it was answered elsewhere', async () => {
    const { call } = setup()
    expect(await call({ id: 'access:old', action: 'deny' })).toEqual({ result: { status: 'gone' } })
  })
})

describe('prompts in the read handlers', () => {
  const src = {
    chats: () => [],
    coworkSessions: () => [{ id: 'w1', title: 'Port the tests', updated: 1, folder: null }],
    rooms: async () => [],
    running: () => ({ chat: new Set<string>(), cowork: new Set(['w1']), room: new Set<string>() }),
    approvals: () => [],
    loadedModels: async () => [],
    prompts: () => [ACCESS],
  } as unknown as RemoteSources
  const handlers = createRemoteHandlers(src)
  const call = (method: string, params: unknown = {}) => dispatchRemoteRpc({ id: 'x', method, params, device }, handlers)

  it('lists and counts them, and the session reads as waiting for you', async () => {
    expect(await call('prompts.list')).toEqual({ result: { prompts: [ACCESS] } })
    expect(await call('status')).toMatchObject({ result: { promptsWaiting: 1 } })
    expect(await call('sessions.list')).toMatchObject({ result: { sessions: [{ id: 'w1', status: 'waiting' }] } })
  })
})

describe('the window’s own prompts', () => {
  beforeEach(() => {
    useAccessRequests.setState({ queue: [], presenters: 1 })
    useBrowserAgentPrompt.setState({ queue: [] })
    useTeamConflictRequests.setState({ bySession: {} })
    useContextSizeApproval.getState().closeModal()
  })

  it('a folder request is answered for the session, through the dialog’s own store', async () => {
    const asked = useAccessRequests.getState().ask({
      threadId: 'w1',
      reason: 'Needs the fixtures',
      prepared: { status: 'ok', display: '/data/fixtures', isDir: true, mode: 'read', requested: '/data/fixtures', resolvedDiffers: false },
    })
    const [p] = appPrompts()
    expect(p).toMatchObject({ kind: 'access', threadId: 'w1', detail: '/data/fixtures' })
    expect(respondAppPrompt(p.id, 'always')).toBe(false)
    expect(respondAppPrompt(p.id, 'session')).toBe(true)
    expect(await asked).toBe('session')
    expect(appPrompts()).toEqual([])
    expect(respondAppPrompt(p.id, 'session')).toBe(false)
  })

  it('a site request is allowed once or denied', async () => {
    const asked = useBrowserAgentPrompt.getState().request({ url: 'https://example.com/a', host: 'example.com', tool: 'browser_open' })
    const [p] = appPrompts()
    expect(respondAppPrompt(p.id, 'once')).toBe(true)
    expect(await asked).toEqual({ decision: 'allow', scope: 'once', subdomains: false })
    const again = useBrowserAgentPrompt.getState().request({ url: 'https://example.com/b', host: 'example.com', tool: 'browser_open' })
    expect(respondAppPrompt(appPrompts()[0].id, 'deny')).toBe(true)
    expect(await again).toMatchObject({ decision: 'deny' })
  })

  it('overlapping team tasks are run one after the other, side by side, or cancelled', async () => {
    const conflict: PairConflict = { tasks: ['api', 'ui'], overlaps: [{ kind: 'same-file', paths: ['src/a.ts', 'src/a.ts'], note: '' }] }
    const ask = () => useTeamConflictRequests.getState().request('w1', 'c1', [] as TeamTask[], [conflict])
    let asked = ask()
    expect(respondAppPrompt(appPrompts()[0].id, 'serialize')).toBe(true)
    expect(await asked).toEqual({ kind: 'decided', decisions: { [conflictKey(conflict)]: { kind: 'serialize', first: 'api', then: 'ui' } } })
    asked = ask()
    expect(respondAppPrompt(appPrompts()[0].id, 'parallel')).toBe(true)
    expect(await asked).toEqual({ kind: 'decided', decisions: { [conflictKey(conflict)]: { kind: 'parallel' } } })
    asked = ask()
    expect(respondAppPrompt(appPrompts()[0].id, 'cancel')).toBe(true)
    expect(await asked).toEqual({ kind: 'cancel' })
  })

  it('a model out of context gets a larger window or drops old messages', async () => {
    const asked = useContextSizeApproval.getState().showApprovalModal()
    const [p] = appPrompts()
    expect(p.kind).toBe('context')
    expect(respondAppPrompt(p.id, 'ctx_len')).toBe(true)
    expect(await asked).toBe('ctx_len')
    expect(appPrompts()).toEqual([])
  })
})
