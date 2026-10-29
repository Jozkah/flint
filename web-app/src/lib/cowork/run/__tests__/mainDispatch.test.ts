import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  dispatch: vi.fn(),
  acquire: vi.fn(() => () => {}),
  abortSubagent: vi.fn(),
  sessions: [] as { id: string; folder: string | null }[],
}))

vi.mock('@/lib/coworkDispatch', () => ({ dispatchCoworkTool: m.dispatch }))
vi.mock('@/hooks/useToolCallRuntime', () => ({
  withToolTiming: (_id: string, fn: () => unknown) => fn(),
}))
vi.mock('@/hooks/useCoworkActiveWork', () => ({
  useCoworkActiveWork: { getState: () => ({ acquire: m.acquire }) },
}))
vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: { getState: () => ({ sessions: m.sessions }) },
}))
vi.mock('@/lib/coworkRunner', () => ({ abortSubagent: m.abortSubagent }))

import { createMainDispatch } from '../mainDispatch'
import { createRunState } from '../runState'

const make = () => {
  const rs = createRunState([])
  const dispatchChild = vi.fn(async () => ({ output: 'child' }))
  const ctx = {
    rs,
    sid: 's1',
    runId: 'r1',
    modelId: 'm',
    folder: '/proj',
    readOnlyFolder: '/proj',
    extraFolders: [],
    mode: 'ask' as never,
    liveMode: () => undefined,
    readFailures: new Map(),
    writeGrant: null as never,
    access: 'direct' as never,
    accessCapability: undefined as never,
    editConsent: undefined as never,
    worktreePath: null,
    unresolvedSkills: [],
    webSearch: true,
    transport: { mcpServerFor: vi.fn(() => 'srv') },
    runAuthority: { folder: '/proj', access: 'direct', destination: 'source' } as never,
    scopedInstructions: vi.fn() as never,
    tasks: {} as never,
    agents: [{ name: 'worker' }] as never,
    nudge: {} as never,
    onTodo: vi.fn() as never,
    onAsk: vi.fn() as never,
    onTeam: vi.fn() as never,
    dispatchChild: dispatchChild as never,
  }
  return { ctx, rs, dispatchChild, dispatch: createMainDispatch(ctx) }
}

const lastCtx = () => m.dispatch.mock.calls.at(-1)![1]

describe('createMainDispatch, characterized', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.sessions = [{ id: 's1', folder: '/proj' }]
  })

  it('dispatches with the frozen run context and the step invocation', () => {
    const { dispatch, rs } = make()
    rs.stepSnapshot = { invocation: 'inv-1' } as never
    const signal = new AbortController().signal
    void dispatch({ toolCallId: 'c1' } as never, signal)
    expect(m.dispatch).toHaveBeenCalledWith({ toolCallId: 'c1' }, expect.any(Object), signal)
    expect(lastCtx()).toMatchObject({
      activity: { session: 's1', run: 'r1', agent: 'main', invocation: 'inv-1' },
      sessionId: 's1',
      modelId: 'm',
      readOnlyFolder: '/proj',
      mode: 'ask',
      access: 'direct',
      webSearch: true,
    })
    expect(lastCtx().mcpServerFor('x')).toBe('srv')
  })

  it('binding stays intact only while the session keeps the run folder', () => {
    const { dispatch } = make()
    void dispatch({ toolCallId: 'c1' } as never, undefined)
    const intact = lastCtx().bindingIntact
    expect(intact()).toBe(true)
    m.sessions = [{ id: 's1', folder: '/other' }]
    expect(intact()).toBe(false)
  })

  it('shells and children hold the run authority', () => {
    const { dispatch, ctx } = make()
    void dispatch({ toolCallId: 'c1' } as never, undefined)
    lastCtx().trackShell()
    lastCtx().trackSubagent()
    expect(m.acquire).toHaveBeenNthCalledWith(1, { sessionId: 's1', kind: 'shell', authority: ctx.runAuthority })
    expect(m.acquire).toHaveBeenNthCalledWith(2, { sessionId: 's1', kind: 'subagent', authority: ctx.runAuthority })
  })

  it('cancels a child by its task id and finds agent defaults by name', () => {
    const { dispatch } = make()
    void dispatch({ toolCallId: 'c1' } as never, undefined)
    lastCtx().cancelChild('call-9')
    expect(m.abortSubagent).toHaveBeenCalledWith('s1', expect.stringContaining('call-9'))
    expect(lastCtx().agentDefaults('worker')).toEqual({ name: 'worker' })
    expect(lastCtx().agentDefaults('nope')).toBeUndefined()
  })

  it('task refuses a bad request and runs a good one as a child', async () => {
    const { dispatch, dispatchChild } = make()
    void dispatch({ toolCallId: 'c1' } as never, undefined)
    const bad = await lastCtx().onTask('c1', {})
    expect(bad).toEqual({ output: expect.stringMatching(/^ERROR: /), isError: true })
    expect(dispatchChild).not.toHaveBeenCalled()
    const good = await lastCtx().onTask('c2', { subagent_name: 'worker', description: 'do it' })
    expect(good).toEqual({ output: 'child' })
    expect(dispatchChild).toHaveBeenCalledWith('c2', expect.objectContaining({ description: 'do it' }))
  })
})
