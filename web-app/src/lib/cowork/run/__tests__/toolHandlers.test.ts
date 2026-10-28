import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  sessions: [] as { id: string; todos?: unknown }[],
  setTodos: vi.fn(),
  setContinuity: vi.fn(),
  setMode: vi.fn(),
  toastInfo: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { info: m.toastInfo, error: vi.fn() } }))
vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: {
    getState: () => ({
      sessions: m.sessions,
      setTodos: m.setTodos,
      setContinuity: m.setContinuity,
      setMode: m.setMode,
    }),
  },
}))

import { createToolHandlers } from '../toolHandlers'
import { createRunState } from '../runState'
import { CONTINUE_QUESTION_ID, PROPOSAL_ACCEPTED_RESULT } from '@/lib/coworkContinuity'
import { EXECUTE_PLAN_LABEL, PLAN_REVIEW_QUESTION_ID, KEEP_PLANNING_LABEL } from '@/lib/coworkPrompt'
import { PLAN_EXECUTE_INSTRUCTION } from '@/lib/coworkPlanReview'
import type { CoworkTurn } from '@/types/coworkSession'

const make = (over: Partial<Parameters<typeof createToolHandlers>[0]> = {}) => {
  const rs = createRunState([])
  const pendingAsks = new Map()
  const transport = {
    heldGroups: [] as never,
    openedGroups: [] as never,
    advertisedGroups: [] as never,
    openGroupsNow: vi.fn(() => [] as string[]),
  }
  let lane: CoworkTurn[] = []
  const ctx = {
    rs,
    sid: 's1',
    folder: '/proj' as string | null,
    access: 'direct',
    inspecting: false,
    planAnchor: 's1-user-0',
    handle: { pendingAsks } as never,
    transport,
    mutateLive: vi.fn((apply: (t: CoworkTurn[]) => CoworkTurn[]) => {
      lane = apply(lane)
    }),
    t: (key: string) => key,
    ...over,
  }
  return { ctx, rs, pendingAsks, transport, handlers: createToolHandlers(ctx), lane: () => lane }
}

const twoOptions = [{ label: 'Yes' }, { label: 'No' }]

describe('createToolHandlers, characterized', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.sessions = [{ id: 's1', todos: undefined }]
  })

  it('refuses an enable request it cannot parse', () => {
    const { handlers } = make()
    const out = handlers.onEnableTools({})
    expect(out.isError).toBe(true)
    expect(out.output).toMatch(/^ERROR: /)
  })

  it('records a todo update against the run prompt', async () => {
    const { handlers } = make()
    const out = await handlers.onTodo({ op: 'view' })
    expect(out.isError).toBeFalsy()
    expect(m.setTodos).toHaveBeenCalledWith('s1', expect.anything(), 's1-user-0')
  })

  it('refuses a malformed todo op without saving', async () => {
    const { handlers } = make()
    const out = await handlers.onTodo(null)
    expect(out.isError).toBe(true)
    expect(m.setTodos).not.toHaveBeenCalled()
  })

  it('refuses a malformed ask at once', async () => {
    const { handlers, pendingAsks } = make()
    const out = await handlers.onAsk('c1', { questions: [] })
    expect(out).toEqual({ output: expect.stringMatching(/^ERROR: /), isError: true })
    expect(pendingAsks.size).toBe(0)
  })

  it('holds an ask on the run handle until answered, then settles it in the lane', async () => {
    const { handlers, pendingAsks, ctx } = make()
    const p = handlers.onAsk('c1', { questions: [{ id: 'q', question: 'Go?', options: twoOptions }] })
    expect(pendingAsks.has('c1')).toBe(true)
    expect(ctx.mutateLive).toHaveBeenCalledTimes(1)
    pendingAsks.get('c1')([{ id: 'q', selected: ['Yes'] }])
    const out = await p
    expect(out.isError).toBeFalsy()
    expect(ctx.mutateLive).toHaveBeenCalledTimes(2)
    expect(m.setContinuity).not.toHaveBeenCalled()
  })

  it('an accepted opening proposal ends the inspecting run and queues the continuation', async () => {
    const { handlers, pendingAsks, rs } = make({ inspecting: true })
    const p = handlers.onAsk('c1', {
      questions: [{ id: CONTINUE_QUESTION_ID, question: 'Do it?', options: [{ label: 'Continue' }, { label: 'Stop' }] }],
    })
    expect(m.setContinuity).toHaveBeenCalledWith('s1', {
      state: 'awaiting-continuation',
      folder: '/proj',
      proposal: 'Do it?',
    })
    pendingAsks.get('c1')([{ id: CONTINUE_QUESTION_ID, selected: ['Continue'] }])
    const out = await p
    expect(m.setContinuity).toHaveBeenLastCalledWith('s1', expect.objectContaining({ state: 'executing' }))
    expect(out).toEqual({ output: PROPOSAL_ACCEPTED_RESULT, endsTurn: true })
    expect(rs.continueWith).toBeTruthy()
  })

  it('a cancelled proposal is recorded as cancelled', async () => {
    const { handlers, pendingAsks } = make({ inspecting: true })
    const p = handlers.onAsk('c1', {
      questions: [{ id: CONTINUE_QUESTION_ID, question: 'Do it?', options: twoOptions }],
    })
    pendingAsks.get('c1')(null)
    await p
    expect(m.setContinuity).toHaveBeenLastCalledWith('s1', expect.objectContaining({ state: 'cancelled' }))
  })

  it('"Execute plan" moves the session to Ask and continues with the execute instruction', async () => {
    const { handlers, pendingAsks, rs } = make({ folder: null })
    const p = handlers.onAsk('c1', {
      questions: [
        {
          id: PLAN_REVIEW_QUESTION_ID,
          question: 'Plan ready',
          options: [{ label: EXECUTE_PLAN_LABEL }, { label: KEEP_PLANNING_LABEL }],
        },
      ],
    })
    pendingAsks.get('c1')([{ id: PLAN_REVIEW_QUESTION_ID, selected: [EXECUTE_PLAN_LABEL] }])
    await p
    expect(m.setMode).toHaveBeenCalledWith('s1', 'ask')
    expect(rs.continueWith).toBe(PLAN_EXECUTE_INSTRUCTION)
    expect(m.toastInfo).toHaveBeenCalledWith('common:coworkPlanExecute.noFolder', { duration: 12000 })
  })
})
