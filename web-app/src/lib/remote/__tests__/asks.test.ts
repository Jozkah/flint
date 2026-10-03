import { describe, it, expect, vi } from 'vitest'
import type { CoworkTurn } from '@/types/coworkSession'
import { checkAskAnswers, pendingAsks } from '../asks'
import { dispatchRemoteRpc, type RemoteHandlers } from '../bridge'
import { createActionHandlers, type RemoteActions } from '../actions'
import { createRemoteHandlers, type RemoteSources } from '../handlers'
import { coworkToolStep } from '../live'
import type { RemoteAsk } from '../protocol'

const ask = (requestId: string, state: 'pending' | 'answered', questions: unknown[]) => ({
  requestId,
  request: { questions },
  sessionId: 'w1',
  callId: requestId,
  at: '2026-10-03T22:53:55.000Z',
  state,
})

const LANG = {
  id: 'lang',
  question: 'Which language?',
  options: [{ label: 'Python', description: 'Simple' }, { label: 'PowerShell' }],
  recommended: 0,
}
const SCOPE = { id: 'scope', question: 'Which folders?', options: [{ label: 'Downloads' }, { label: 'Home' }], multi: true }

const turns = (...asks: ReturnType<typeof ask>[]) =>
  [{ role: 'assistant', content: 'Let me check.', asks }] as unknown as CoworkTurn[]

describe('pendingAsks', () => {
  it('lists the questions still waiting, with their options', () => {
    const out = pendingAsks({ w1: turns(ask('q1', 'pending', [LANG, SCOPE]), ask('q0', 'answered', [LANG])) }, () => true)
    expect(out).toEqual([
      {
        requestId: 'q1',
        threadId: 'w1',
        questions: [
          { id: 'lang', question: 'Which language?', options: [{ label: 'Python', description: 'Simple' }, { label: 'PowerShell' }], recommended: 0 },
          { id: 'scope', question: 'Which folders?', options: [{ label: 'Downloads' }, { label: 'Home' }], multi: true },
        ],
        requestedAt: Date.parse('2026-10-03T22:53:55.000Z'),
      },
    ])
  })

  it('leaves out a question whose run is gone: nothing could take the answer', () => {
    expect(pendingAsks({ w1: turns(ask('q1', 'pending', [LANG])) }, () => false)).toEqual([])
  })

  it('carries the staged plan under a plan review, and only there', () => {
    const review = { id: 'plan_review', question: 'Run this plan?', options: [{ label: 'Execute plan' }, { label: 'Keep planning' }] }
    const todos = {
      phases: [
        { name: 'Build', tasks: [{ content: 'Write the script', status: 'completed' as const }, { content: 'Test it', status: 'pending' as const }] },
        { name: 'Empty', tasks: [] },
      ],
    }
    const [withPlan] = pendingAsks({ w1: turns(ask('q1', 'pending', [review])) }, () => true, () => todos)
    expect(withPlan.plan).toEqual([
      { name: 'Build', tasks: [{ content: 'Write the script', done: true }, { content: 'Test it', done: false }] },
    ])
    const [plain] = pendingAsks({ w1: turns(ask('q2', 'pending', [LANG])) }, () => true, () => todos)
    expect(plain.plan).toBeUndefined()
  })
})

const REMOTE: RemoteAsk = pendingAsks({ w1: turns(ask('q1', 'pending', [LANG, SCOPE])) }, () => true)[0]

describe('checkAskAnswers', () => {
  it('accepts option labels, and the user’s own words in their place', () => {
    expect(
      checkAskAnswers(REMOTE, [
        { id: 'lang', selected: ['Python'] },
        { id: 'scope', selected: ['Downloads', 'Home', 'Home'] },
      ])
    ).toEqual([
      { id: 'lang', selected: ['Python'] },
      { id: 'scope', selected: ['Downloads', 'Home'] },
    ])
    expect(
      checkAskAnswers(REMOTE, [
        { id: 'lang', selected: ['Python'], custom_input: '  Rust please  ' },
        { id: 'scope', selected: ['Home'] },
      ])
    ).toEqual([
      { id: 'lang', selected: [], custom_input: 'Rust please' },
      { id: 'scope', selected: ['Home'] },
    ])
  })

  it.each([
    ['not a list', 'x'],
    ['a question left out', [{ id: 'lang', selected: ['Python'] }]],
    ['an option that was not offered', [{ id: 'lang', selected: ['Ruby'] }, { id: 'scope', selected: ['Home'] }]],
    ['two choices for a single-choice question', [{ id: 'lang', selected: ['Python', 'PowerShell'] }, { id: 'scope', selected: ['Home'] }]],
    ['an empty answer', [{ id: 'lang', selected: [] }, { id: 'scope', selected: ['Home'] }]],
  ])('refuses %s', (_name, answers) => {
    expect(typeof checkAskAnswers(REMOTE, answers)).toBe('string')
  })
})

const device = { id: 'd1', name: 'Pixel' }

describe('asks.respond', () => {
  const setup = (over: Partial<RemoteActions> = {}) => {
    const a = {
      findAsk: vi.fn((threadId: string, requestId: string) => (threadId === 'w1' && requestId === 'q1' ? REMOTE : null)),
      answerAsk: vi.fn(() => true),
      ...over,
    } as unknown as RemoteActions
    const handlers = createActionHandlers(a) as unknown as RemoteHandlers
    const call = (params: unknown) => dispatchRemoteRpc({ id: 'x', method: 'asks.respond', params, device }, handlers)
    return { a, call }
  }

  it('hands the run its checked answers', async () => {
    const { a, call } = setup()
    const answers = [
      { id: 'lang', selected: ['PowerShell'] },
      { id: 'scope', selected: ['Downloads'] },
    ]
    expect(await call({ requestId: 'q1', threadId: 'w1', answers })).toEqual({ result: { status: 'answered' } })
    expect(a.answerAsk).toHaveBeenCalledWith('w1', 'q1', answers)
  })

  it('skips with null, so the run is told nothing was chosen', async () => {
    const { a, call } = setup()
    expect(await call({ requestId: 'q1', threadId: 'w1', answers: null })).toEqual({ result: { status: 'answered' } })
    expect(a.answerAsk).toHaveBeenCalledWith('w1', 'q1', null)
  })

  it('says gone when it was answered elsewhere or its run ended', async () => {
    const { a, call } = setup()
    expect(await call({ requestId: 'old', threadId: 'w1', answers: null })).toEqual({ result: { status: 'gone' } })
    expect(a.answerAsk).not.toHaveBeenCalled()
    const late = setup({ answerAsk: vi.fn(() => false) })
    expect(await late.call({ requestId: 'q1', threadId: 'w1', answers: null })).toEqual({ result: { status: 'gone' } })
  })

  it('refuses answers that do not fit the question, and never passes them on', async () => {
    const { a, call } = setup()
    expect(await call({ requestId: 'q1', threadId: 'w1', answers: [{ id: 'lang', selected: ['Ruby'] }] })).toMatchObject({
      error: { code: 'bad_params' },
    })
    expect(await call({ requestId: 'q1' })).toMatchObject({ error: { code: 'bad_params' } })
    expect(a.answerAsk).not.toHaveBeenCalled()
  })
})

describe('questions in the read handlers', () => {
  const src = {
    chats: () => [],
    coworkSessions: () => [{ id: 'w1', title: 'Rename files', updated: 1, folder: null }],
    rooms: async () => [],
    running: () => ({ chat: new Set<string>(), cowork: new Set(['w1']), room: new Set<string>() }),
    approvals: () => [],
    coworkDetail: (id: string) => (id === 'w1' ? ({ id: 'w1', title: 'Rename files', status: 'running' } as never) : null),
    loadedModels: async () => [],
    asks: () => [REMOTE],
  } as unknown as RemoteSources
  const handlers = createRemoteHandlers(src)
  const call = (method: string, params: unknown = {}) => dispatchRemoteRpc({ id: 'x', method, params, device }, handlers)

  it('lists them and counts them', async () => {
    expect(await call('asks.list')).toEqual({ result: { asks: [REMOTE] } })
    expect(await call('status')).toMatchObject({ result: { approvalsWaiting: 0, questionsWaiting: 1 } })
  })

  it('a session with a question waiting is waiting for you, not running', async () => {
    expect(await call('cowork.get', { id: 'w1' })).toMatchObject({ result: { status: 'waiting' } })
    expect(await call('sessions.list')).toMatchObject({ result: { sessions: [{ id: 'w1', status: 'waiting' }] } })
  })
})

describe('the ask step in the live timeline', () => {
  const step = (over: Partial<CoworkTurn>) =>
    coworkToolStep({ role: 'tool', callId: 'c1', name: 'ask', content: '', ...over } as CoworkTurn, new Set())

  it('waits on the user while open, and is done once answered', () => {
    expect(step({ status: 'running' })?.status).toBe('awaiting')
    expect(step({ status: 'done' })?.status).toBe('done')
  })
})
