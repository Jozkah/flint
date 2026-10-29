import { describe, expect, it, vi } from 'vitest'
import { __testing, type StepResult, type ToolOutcome } from '../coworkRunner'

const { checkLimits, stepFailed, afterStep } = __testing

type State = Parameters<typeof stepFailed>[0]
type Deps = Parameters<typeof stepFailed>[1]

function state(over: Partial<State> = {}): State {
  return {
    messages: [],
    observed: [],
    step: 1,
    spend: { spent: 10 } as State['spend'],
    usage: null,
    recentGrowth: [],
    lastPromptSeen: undefined,
    autoContinued: false,
    timeoutResumed: false,
    skippedForSteering: [],
    ...over,
  }
}

function deps(over: Partial<Deps> = {}): Deps {
  let n = 0
  return {
    sendStep: vi.fn(),
    dispatch: vi.fn(),
    sink: {} as Deps['sink'],
    onStep: vi.fn(),
    nextMessageId: () => `m${++n}`,
    ...over,
  } as Deps
}

const step = (over: Partial<StepResult> = {}): StepResult =>
  ({ text: 'hi', toolCalls: [], usage: null, ...over }) as StepResult

const live = new AbortController().signal

describe('checkLimits', () => {
  it('stops for abort, steps, tokens and the deadline, in that order', () => {
    const aborted = new AbortController()
    aborted.abort()
    const base = { messages: [], deps: deps() }
    expect(checkLimits(state(), { ...base, signal: aborted.signal }, 5, () => 0)?.stoppedBy).toBe('aborted')
    expect(checkLimits(state({ step: 5 }), { ...base, signal: live }, 5, () => 0)?.stoppedBy).toBe('steps')
    expect(
      checkLimits(state(), { ...base, signal: live, sessionTokenLimit: 10 }, 5, () => 0)?.stoppedBy
    ).toBe('tokens')
    expect(checkLimits(state(), { ...base, signal: live }, 5, () => 0)).toBeNull()
  })
})

describe('stepFailed', () => {
  it('resumes a stalled step once, then stops with timeout', () => {
    const st = state()
    const d = deps()
    expect(stepFailed(st, d, live, new Error('stalled'), true)).toEqual({ kind: 'continue' })
    expect(st.messages).toHaveLength(1)
    const t = stepFailed(st, d, live, new Error('stalled'), true)
    expect(t).toMatchObject({ kind: 'finish', outcome: { stoppedBy: 'timeout', errorText: 'stalled' } })
  })

  it('reports a transport failure as an error outcome', () => {
    expect(stepFailed(state(), deps(), live, new Error('boom'), false)).toMatchObject({
      kind: 'finish',
      outcome: { stoppedBy: 'error', errorText: 'boom', steps: 1, sessionTokens: 10 },
    })
  })

  it('treats an abort as aborted with no error text', () => {
    const c = new AbortController()
    c.abort()
    const t = stepFailed(state(), deps(), c.signal, new Error('x'), false)
    expect(t).toMatchObject({ kind: 'finish', outcome: { stoppedBy: 'aborted' } })
    expect(t.kind === 'finish' && t.outcome.errorText).toBeUndefined()
  })
})

describe('afterStep', () => {
  it('finishes on a plain answer', async () => {
    expect(await afterStep(state(), deps(), live, step(), new Map())).toMatchObject({
      kind: 'finish',
      outcome: { stoppedBy: 'done' },
    })
  })

  it('continues after tool calls and finishes when a call ends the turn', async () => {
    const calls = [{ toolCallId: 'c', toolName: 't', input: {} }] as StepResult['toolCalls']
    const ok = new Map<string, ToolOutcome>([['c', { output: 'ok' }]])
    expect(await afterStep(state(), deps(), live, step({ toolCalls: calls }), ok)).toEqual({
      kind: 'continue',
    })
    const ends = new Map<string, ToolOutcome>([['c', { output: 'ok', endsTurn: true }]])
    expect(await afterStep(state(), deps(), live, step({ toolCalls: calls }), ends)).toMatchObject({
      kind: 'finish',
      outcome: { stoppedBy: 'done' },
    })
  })

  it('continues a reply cut off by the output limit once', async () => {
    const st = state()
    const cut = step({ finishReason: 'length' })
    expect(await afterStep(st, deps(), live, cut, new Map())).toEqual({ kind: 'continue' })
    expect(await afterStep(st, deps(), live, cut, new Map())).toMatchObject({ kind: 'finish' })
  })

  it('nudges an empty reply once', async () => {
    const st = state()
    expect(await afterStep(st, deps(), live, step({ text: '' }), new Map())).toEqual({
      kind: 'continue',
    })
    expect(st.autoContinued).toBe(true)
  })

  it('stops as aborted when the step was aborted', async () => {
    expect(await afterStep(state(), deps(), live, step({ aborted: true }), new Map())).toMatchObject({
      kind: 'finish',
      outcome: { stoppedBy: 'aborted' },
    })
  })
})
