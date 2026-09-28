import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dispatchRemoteRpc } from '../bridge'
import { createActionHandlers, type RemoteActions } from '../actions'
import { createIdempotencyCache } from '../idempotency'
import type { RemoteHandlers } from '../bridge'

const device = { id: 'd1', name: 'Pixel' }

function mockActions(over: Partial<RemoteActions> = {}): RemoteActions {
  return {
    chatExists: vi.fn((id: string) => id === 'c1'),
    chatBusy: vi.fn(() => false),
    createChat: vi.fn(async () => 'c-new'),
    setWebSearch: vi.fn(),
    setChatReasoning: vi.fn(),
    setChatModel: vi.fn(),
    coworkExists: vi.fn((id: string) => id === 'w1'),
    coworkBusy: vi.fn(() => false),
    knownFolders: vi.fn(() => ['/home/jo/acme']),
    createCowork: vi.fn(() => 'w-new'),
    setCoworkMode: vi.fn(),
    setCoworkModel: vi.fn(),
    coworkAccess: vi.fn(() => 'managed-worktree' as const),
    setCoworkReviewOnly: vi.fn(async () => {}),
    open: vi.fn(),
    sendViaComposer: vi.fn(async () => true),
    enqueue: vi.fn(),
    stop: vi.fn(async () => true),
    stopAll: vi.fn(async () => 2),
    findApproval: vi.fn((rid: string) =>
      rid === 'ap1' ? { toolCallId: 'tc1', scopes: ['once', 'thread', 'always'] as ('once' | 'thread' | 'always')[] } : null
    ),
    resolveApproval: vi.fn(),
    permissions: vi.fn(async () => ({ approvals: true, alwaysAllow: false })),
    roomExists: vi.fn(async (id: string) => id === 'r1'),
    room: {
      send: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      cancelTurn: vi.fn(async () => {}),
      selectNext: vi.fn(async () => {}),
      callVote: vi.fn(async () => {}),
      synthesize: vi.fn(async () => {}),
      requestFinalPositions: vi.fn(async () => {}),
    },
    setNotificationPrefs: vi.fn(),
    ...over,
  }
}

let a: RemoteActions
let handlers: RemoteHandlers
const call = (method: string, params: unknown, dev = device) =>
  dispatchRemoteRpc({ id: 'x', method, params, device: dev }, handlers)

function setup(over: Partial<RemoteActions> = {}) {
  a = mockActions(over)
  handlers = createActionHandlers(a, createIdempotencyCache()) as unknown as RemoteHandlers
}

describe('chat.send', () => {
  beforeEach(() => setup())

  it('starts a new chat through the desktop composer path, with its toggles', async () => {
    const r = await call('chat.send', {
      clientId: 'm-000001',
      text: '  Hello  ',
      new: true,
      model: { id: 'qwen', provider: 'llamacpp' },
      webSearch: false,
      reasoning: 'on',
    })
    expect(r).toEqual({ result: { kind: 'chat', id: 'c-new', delivery: 'sent' } })
    expect(a.setWebSearch).toHaveBeenCalledWith(false)
    expect(a.setChatReasoning).toHaveBeenCalledWith(null, 'on', { id: 'qwen', provider: 'llamacpp' })
    expect(a.createChat).toHaveBeenCalledWith({ text: 'Hello', model: { id: 'qwen', provider: 'llamacpp' } })
  })

  it('sends into an idle chat through its own composer, after opening it', async () => {
    const r = await call('chat.send', { clientId: 'm-000002', id: 'c1', text: 'Next' })
    expect(r).toEqual({ result: { kind: 'chat', id: 'c1', delivery: 'sent' } })
    expect(a.open).toHaveBeenCalledWith('chat', 'c1')
    expect(a.sendViaComposer).toHaveBeenCalledWith('chat', 'c1', 'Next')
    expect(a.enqueue).not.toHaveBeenCalled()
  })

  it('queues while a run is going, or steers when asked, as the desktop composer does', async () => {
    setup({ chatBusy: vi.fn(() => true) })
    expect(await call('chat.send', { clientId: 'm-000003', id: 'c1', text: 'later' })).toMatchObject({
      result: { delivery: 'queued' },
    })
    expect(a.enqueue).toHaveBeenCalledWith('c1', 'later', false)
    expect(await call('chat.send', { clientId: 'm-000004', id: 'c1', text: 'now', steer: true })).toMatchObject({
      result: { delivery: 'steered' },
    })
    expect(a.enqueue).toHaveBeenLastCalledWith('c1', 'now', true)
    expect(a.sendViaComposer).not.toHaveBeenCalled()
  })

  it('a retry with the same clientId is answered, not sent again', async () => {
    const p = { clientId: 'm-retry1', id: 'c1', text: 'once' }
    const [first, second] = await Promise.all([call('chat.send', p), call('chat.send', p)])
    expect(first).toEqual({ result: { kind: 'chat', id: 'c1', delivery: 'sent' } })
    expect(second).toEqual({ result: { kind: 'chat', id: 'c1', delivery: 'sent', duplicate: true } })
    expect(await call('chat.send', p)).toMatchObject({ result: { duplicate: true } })
    expect(a.sendViaComposer).toHaveBeenCalledTimes(1)
    // Another phone's id is its own.
    await call('chat.send', p, { id: 'd2', name: 'iPad' })
    expect(a.sendViaComposer).toHaveBeenCalledTimes(2)
  })

  it('a send that failed may be tried again under the same id', async () => {
    const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    setup({ sendViaComposer: send })
    const p = { clientId: 'm-fail01', id: 'c1', text: 'x' }
    expect(await call('chat.send', p)).toMatchObject({ error: { code: 'unavailable' } })
    expect(await call('chat.send', p)).toEqual({ result: { kind: 'chat', id: 'c1', delivery: 'sent' } })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('refuses a missing clientId, empty text and an unknown chat', async () => {
    expect(await call('chat.send', { text: 'x', new: true })).toMatchObject({ error: { code: 'bad_params' } })
    expect(await call('chat.send', { clientId: 'm-000005', text: '   ', new: true })).toMatchObject({ error: { code: 'bad_params' } })
    expect(await call('chat.send', { clientId: 'm-000006', id: 'nope', text: 'x' })).toMatchObject({ error: { code: 'not_found' } })
  })
})

describe('cowork.send', () => {
  beforeEach(() => setup())

  it('creates a session in a known folder with its mode, then sends', async () => {
    const r = await call('cowork.send', { clientId: 'm-cw0001', text: 'Fix it', new: true, folder: '/home/jo/acme', mode: 'review' })
    expect(r).toEqual({ result: { kind: 'cowork', id: 'w-new', delivery: 'sent' } })
    expect(a.createCowork).toHaveBeenCalledWith({ folder: '/home/jo/acme', mode: 'review', model: undefined })
    expect(a.sendViaComposer).toHaveBeenCalledWith('cowork', 'w-new', 'Fix it')
  })

  it('keeps folders and write access to the computer', async () => {
    expect(await call('cowork.send', { clientId: 'm-cw0002', text: 'x', new: true, folder: '/etc' })).toMatchObject({
      error: { code: 'bad_params' },
    })
    expect(await call('cowork.send', { clientId: 'm-cw0003', text: 'x', new: true, access: 'edit-folder' })).toMatchObject({
      error: { code: 'desktop_only' },
    })
    expect(a.createCowork).not.toHaveBeenCalled()
  })

  it('queues into a running session', async () => {
    setup({ coworkBusy: vi.fn(() => true) })
    expect(await call('cowork.send', { clientId: 'm-cw0004', id: 'w1', text: 'also this' })).toMatchObject({
      result: { delivery: 'queued' },
    })
    expect(a.enqueue).toHaveBeenCalledWith('w1', 'also this', false)
  })
})

describe('run.stop', () => {
  beforeEach(() => setup())
  it('stops one run, or all activity', async () => {
    expect(await call('run.stop', { kind: 'cowork', id: 'w1' })).toEqual({ result: { stopped: 1 } })
    expect(a.stop).toHaveBeenCalledWith('cowork', 'w1')
    expect(await call('run.stop', { all: true })).toEqual({ result: { stopped: 2 } })
    expect(await call('run.stop', { kind: 'bogus', id: 'x' })).toMatchObject({ error: { code: 'bad_params' } })
  })
})

describe('approvals.respond', () => {
  beforeEach(() => setup())

  it('resolves the desktop’s own prompt with the card’s scope', async () => {
    expect(await call('approvals.respond', { requestId: 'ap1', decision: 'allow', scope: 'thread' })).toEqual({
      result: { status: 'answered' },
    })
    expect(a.resolveApproval).toHaveBeenCalledWith('tc1', 'ap1', 'allow-thread')
    await call('approvals.respond', { requestId: 'ap1', decision: 'deny' })
    expect(a.resolveApproval).toHaveBeenLastCalledWith('tc1', 'ap1', 'deny')
  })

  it('says gone when it was answered elsewhere', async () => {
    expect(await call('approvals.respond', { requestId: 'old', decision: 'allow' })).toEqual({ result: { status: 'gone' } })
    expect(a.resolveApproval).not.toHaveBeenCalled()
  })

  it('checks the phone permissions again, and the scopes offered', async () => {
    expect(await call('approvals.respond', { requestId: 'ap1', decision: 'allow', scope: 'always' })).toMatchObject({
      error: { code: 'forbidden' },
    })
    setup({ permissions: vi.fn(async () => ({ approvals: false, alwaysAllow: false })) })
    expect(await call('approvals.respond', { requestId: 'ap1', decision: 'deny' })).toMatchObject({ error: { code: 'forbidden' } })
    setup({
      permissions: vi.fn(async () => ({ approvals: true, alwaysAllow: true })),
      findApproval: vi.fn(() => ({ toolCallId: 'tc1', scopes: ['once'] as ('once' | 'thread' | 'always')[] })),
    })
    expect(await call('approvals.respond', { requestId: 'ap1', decision: 'allow', scope: 'always' })).toMatchObject({
      error: { code: 'bad_params' },
    })
    expect(a.resolveApproval).not.toHaveBeenCalled()
  })
})

describe('rooms', () => {
  beforeEach(() => setup())

  it('room.send addresses everyone, the moderator or a participant', async () => {
    await call('room.send', { clientId: 'm-rm0001', id: 'r1', text: 'Hi all' })
    expect(a.room.send).toHaveBeenLastCalledWith('r1', 'Hi all', { kind: 'room' })
    await call('room.send', { clientId: 'm-rm0002', id: 'r1', text: 'You', to: 'p2' })
    expect(a.room.send).toHaveBeenLastCalledWith('r1', 'You', { kind: 'participant', participantId: 'p2' })
    await call('room.send', { clientId: 'm-rm0003', id: 'r1', text: 'Mod', to: 'moderator' })
    expect(a.room.send).toHaveBeenLastCalledWith('r1', 'Mod', { kind: 'moderator' })
    expect(a.open).toHaveBeenCalledWith('room', 'r1')
    expect(await call('room.send', { clientId: 'm-rm0004', id: 'nope', text: 'x' })).toMatchObject({ error: { code: 'not_found' } })
  })

  it('room.control calls the room controller', async () => {
    await call('room.control', { id: 'r1', action: 'pause' })
    expect(a.room.pause).toHaveBeenCalledWith('r1')
    await call('room.control', { id: 'r1', action: 'next', participantId: 'p3' })
    expect(a.room.selectNext).toHaveBeenCalledWith('r1', 'p3')
    await call('room.control', { id: 'r1', action: 'vote', proposal: ' Ship it ' })
    expect(a.room.callVote).toHaveBeenCalledWith('r1', 'Ship it')
    await call('room.control', { id: 'r1', action: 'synthesize' })
    expect(a.room.synthesize).toHaveBeenCalled()
    expect(await call('room.control', { id: 'r1', action: 'explode' })).toMatchObject({ error: { code: 'bad_params' } })
  })
})

describe('settings.set', () => {
  beforeEach(() => setup())

  it('changes what has a plain desktop setter', async () => {
    expect(await call('settings.set', { key: 'webSearch', value: true })).toEqual({ result: { ok: true } })
    expect(a.setWebSearch).toHaveBeenCalledWith(true)
    const prefs = { approvals: true, runFinished: false, roomTurns: true, errors: true }
    await call('settings.set', { key: 'notifications', value: prefs })
    expect(a.setNotificationPrefs).toHaveBeenCalledWith('d1', prefs)
    await call('settings.set', { scope: 'cowork', id: 'w1', mode: 'auto' })
    expect(a.setCoworkMode).toHaveBeenCalledWith('w1', 'auto')
    await call('settings.set', { scope: 'chat', id: 'c1', reasoning: 'off' })
    expect(a.setChatReasoning).toHaveBeenCalledWith('c1', 'off')
  })

  it('narrows access to review-only, never widens it', async () => {
    await call('settings.set', { scope: 'cowork', id: 'w1', access: 'review-only' })
    expect(a.setCoworkReviewOnly).toHaveBeenCalledWith('w1')
    expect(await call('settings.set', { scope: 'cowork', id: 'w1', access: 'edit-folder' })).toMatchObject({
      error: { code: 'desktop_only' },
    })
  })

  it('leaves everything else on the computer', async () => {
    expect(await call('settings.set', { key: 'remote.allowApprovals', value: true })).toMatchObject({
      error: { code: 'desktop_only' },
    })
    expect(await call('settings.set', { key: 'proxy.enabled', value: true })).toMatchObject({
      error: { code: 'desktop_only' },
    })
  })
})
