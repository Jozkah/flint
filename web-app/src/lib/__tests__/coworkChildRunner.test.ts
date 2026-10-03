import { describe, it, expect, vi, beforeEach } from 'vitest'

const { runSubagent } = vi.hoisted(() => ({ runSubagent: vi.fn() }))
vi.mock('@/lib/coworkSubagent', async (orig) => ({
  ...(await orig<typeof import('../coworkSubagent')>()),
  runSubagent,
}))
vi.mock('@/lib/eventLog', () => ({ recordEvents: vi.fn() }))
vi.mock('@/lib/toolActivity', async (orig) => ({
  ...(await orig<typeof import('../toolActivity')>()),
  recordToolActivity: vi.fn(async () => {}),
}))

import { createChildRunner, type ChildRunnerEnv } from '../coworkChildRunner'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { emptyActivityState, taskIdFor } from '../coworkActivity'
import { abortSubagent, beginRun, endRun } from '../coworkRunner'
import type { SubagentEvents } from '../coworkSubagent'
import { useSubagentSettings } from '@/hooks/useSubagentSettings'

const defs = [
  {
    name: 'explorer',
    description: 'reads',
    system_prompt: 'You explore.',
    allowed_tools: null,
    model: null,
    scope: 'builtin' as const,
  },
]

const SID = 's1'
const RUN = 'run-1'
const id = (callId: string) => taskIdFor(SID, RUN, callId)
const task = (callId: string) => useCoworkActivity.getState().tasks[id(callId)]

function env(over: Partial<ChildRunnerEnv> = {}): ChildRunnerEnv {
  const controller = new AbortController()
  return {
    sessionId: SID,
    runId: RUN,
    run: { sessionId: SID, runId: RUN, title: 'ask' },
    modelId: 'qwen',
    definitions: defs,
    signal: controller.signal,
    model: () => ({}) as never,
    providerOptions: () => undefined,
    parentTools: () => ({ read: {} }) as never,
    anchorMessageId: () => undefined,
    setup: () => ({
      system: { workspacePath: '/ws', readOnlyFolder: null, bashAvailable: false },
      dispatch: vi.fn(async () => ({ output: 'ok' })),
      activity: () => ({ session: SID, run: RUN, agent: 'explorer' }) as never,
    }),
    ...over,
  }
}

beforeEach(() => {
  runSubagent.mockReset()
  useCoworkActivity.setState({ ...emptyActivityState() })
  beginRun(SID, RUN, new AbortController())
  useSubagentSettings.getState().reset()
})

/** Drives the events a real child would emit, then answers. */
const answers = (output: string, extra: Record<string, unknown> = {}) =>
  runSubagent.mockImplementation(async (opts: { events: SubagentEvents }) => {
    opts.events.onStart()
    opts.events.onInner({ type: 'tool_call', id: 't1', name: 'read', args: { path: 'a' } })
    opts.events.onInner({ type: 'tool_result', id: 't1', content: 'body', is_error: false })
    opts.events.onEnd({ total_tokens: 40 })
    return { output, usage: null, sessionTokens: 0, ...extra }
  })

describe('createChildRunner', () => {
  it('refuses an unknown subagent and a missing model without recording anything', async () => {
    const run = createChildRunner(env())
    const unknown = await run('c1', { subagent_name: 'nope', description: 'd' })
    expect(unknown.isError).toBe(true)
    expect(unknown.output).toContain('unknown subagent')

    const noModel = await createChildRunner(env({ model: () => null }))('c2', {
      subagent_name: 'explorer',
      description: 'd',
    })
    expect(noModel.output).toContain('no model is loaded')
    expect(Object.keys(useCoworkActivity.getState().tasks)).toHaveLength(0)
    expect(runSubagent).not.toHaveBeenCalled()
  })

  it('records the dispatch, streams the trace into the record, and settles done', async () => {
    answers('the answer')
    const out = await createChildRunner(env())('c1', { subagent_name: 'explorer', description: 'find it' })
    expect(out).toEqual({ output: 'the answer', isError: undefined })
    expect(task('c1')).toMatchObject({
      kind: 'agent',
      status: 'done',
      agentName: 'explorer',
      description: 'find it',
      model: 'qwen',
      output: 'the answer',
      toolCount: 1,
      usage: { total_tokens: 40 },
    })
    // No transcript lane was given, so the trace came from the runner itself.
    expect(task('c1').transcript?.[0]).toMatchObject({ role: 'tool', name: 'read', result: 'body' })
    expect(task('c1').background).toBeUndefined()
  })

  it('marks a background request and a team member as background tasks', async () => {
    answers('x')
    await createChildRunner(env())('bg', { subagent_name: 'explorer', description: 'd', background: true })
    await createChildRunner(env())('member', { subagent_name: 'explorer', description: 'd' }, undefined, 'team-row')
    expect(task('bg').background).toBe(true)
    expect(task('member').background).toBe(true)
    expect(task('member').parentTaskId).toBe('team-row')
  })

  it('records the checkout an isolated child works in, on its own record, so its row can lead to the review', async () => {
    answers('x')
    const destination = { ownerId: 'o', path: 'C:/wt/one', branch: 'jan/cowork/one', baseSha: 'abc', grantId: 'g' }
    await createChildRunner(env())('c1:one', { subagent_name: 'explorer', description: 'd' }, undefined, 'team-row', destination as never, 'one')
    expect(useCoworkActivity.getState().tasks[id('c1:one')].checkout).toEqual({
      path: 'C:/wt/one',
      branch: 'jan/cowork/one',
      taskId: 'one',
    })
    // A child that shares the folder records none.
    await createChildRunner(env())('c2', { subagent_name: 'explorer', description: 'd' })
    expect(task('c2').checkout).toBeUndefined()
  })

  it('records an error result as an error, and flags a cut or step-limited answer', async () => {
    answers('partial', { isError: true, capped: true, stoppedAtLimit: true, full: 'partial+' })
    const out = await createChildRunner(env())('c1', { subagent_name: 'explorer', description: 'd' })
    expect(out).toMatchObject({ isError: true, full: 'partial+' })
    expect(task('c1')).toMatchObject({ status: 'error', resultCapped: true, stoppedAtLimit: true })
  })

  it('settles a child that throws, and lets the throw through', async () => {
    runSubagent.mockRejectedValue(new Error('boom'))
    await expect(
      createChildRunner(env())('c1', { subagent_name: 'explorer', description: 'd' })
    ).rejects.toThrow('boom')
    expect(task('c1').status).toBe('error')
  })

  it('stops through the registered handle and records cancelled, not failed', async () => {
    runSubagent.mockImplementation(async (opts: { signal: AbortSignal }) => {
      expect(abortSubagent(SID, id('c1'), 'cancelled')).toBe(true)
      expect(opts.signal.aborted).toBe(true)
      return { output: '(the subagent was cancelled)', isError: true, usage: null, sessionTokens: 0 }
    })
    await createChildRunner(env())('c1', { subagent_name: 'explorer', description: 'd' })
    expect(task('c1').status).toBe('cancelled')
  })

  it('stops every child when the run’s signal aborts, and a team’s signal stops one', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    runSubagent.mockImplementation(async (opts: { signal: AbortSignal }) => {
      seen = opts.signal
      controller.abort()
      return { output: 'x', isError: true, usage: null, sessionTokens: 0 }
    })
    await createChildRunner(env({ signal: controller.signal }))('c1', {
      subagent_name: 'explorer',
      description: 'd',
    })
    expect(seen?.aborted).toBe(true)

    const team = new AbortController()
    team.abort()
    runSubagent.mockImplementation(async (opts: { signal: AbortSignal }) => {
      seen = opts.signal
      return { output: 'x', isError: true, usage: null, sessionTokens: 0 }
    })
    await createChildRunner(env())('c2', { subagent_name: 'explorer', description: 'd' }, team.signal)
    expect(seen?.aborted).toBe(true)
  })

  it('records a queued child with its position, and reports usage to a surface that keeps a budget', async () => {
    const onUsage = vi.fn()
    runSubagent.mockImplementation(async (opts: { events: SubagentEvents }) => {
      opts.events.onQueued(2)
      expect(task('c1')).toMatchObject({ status: 'queued', waiting: 2 })
      opts.events.onStart()
      opts.events.onEnd({ total_tokens: 99 })
      return { output: 'x', usage: null, sessionTokens: 0 }
    })
    await createChildRunner(env({ onUsage }))('c1', { subagent_name: 'explorer', description: 'd' })
    expect(onUsage).toHaveBeenCalledWith({ total_tokens: 99 })
  })

  it('uses the transcript lane when a surface keeps one, and passes the step budget on', async () => {
    const lane = {
      queue: vi.fn(),
      start: vi.fn(),
      inner: vi.fn(),
      turns: vi.fn(() => [{ role: 'assistant' as const, content: 'from the lane' }]),
      end: vi.fn(),
      attach: vi.fn(),
    }
    answers('done')
    await createChildRunner(env({ lane, maxSteps: 7 }))('c1', { subagent_name: 'explorer', description: 'd' })
    expect(lane.start).toHaveBeenCalledWith('c1', 'explorer')
    expect(lane.inner).toHaveBeenCalledTimes(2)
    expect(lane.attach).toHaveBeenCalledWith('c1', 'done')
    expect(task('c1').transcript).toEqual([{ role: 'assistant', content: 'from the lane' }])
    expect(runSubagent.mock.calls[0][0].maxSteps).toBe(7)
  })

  it('lets go of its stop handle afterwards', async () => {
    answers('x')
    await createChildRunner(env())('c1', { subagent_name: 'explorer', description: 'd' })
    expect(abortSubagent(SID, id('c1'))).toBe(false)
    endRun(SID, RUN)
  })

  it('titles the row by the errand, not the role', async () => {
    answers('x')
    const run = createChildRunner(env())
    await run('a', { subagent_name: 'explorer', description: 'Survey the radar package. Then list its tests.' })
    await run('b', { subagent_name: 'explorer', description: 'Survey the rooms engine.', title: 'Rooms engine' })
    await run('c', { subagent_name: 'explorer', description: '   ' })
    expect(task('a').title).toBe('Survey the radar package')
    expect(task('b').title).toBe('Rooms engine')
    expect(task('a').agentName).toBe('explorer')
    expect(task('c').title).toBe('explorer')
  })

  it('applies the Subagents settings to the child and records what it used, without touching its tools', async () => {
    answers('x')
    useSubagentSettings.getState().setGlobal('workProfile', 'review')
    const parentTools = { read: {}, bash: {} } as never
    await createChildRunner(env({ parentTools: () => parentTools }))('s', { subagent_name: 'explorer', description: 'd' })
    const opts = runSubagent.mock.calls[0][0]
    expect(opts.extraSystem?.join('\n')).toContain('Review')
    expect(opts.extraSystem?.join('\n')).toContain('does not change which tools')
    // The child still gets exactly the parent's tools and definition allowlist.
    expect(opts.parentTools).toBe(parentTools)
    expect(opts.resolved.allowedTools).toBeNull()
    expect(task('s').profile).toBe('Review')
  })

  it('a child never gets tools beyond its parent, whatever the settings say', async () => {
    answers('x')
    useSubagentSettings.getState().setGlobal('workProfile', 'execute')
    useSubagentSettings.getState().setRole('explorer', 'assistantId', 'jan')
    const narrow = [{ ...defs[0], allowed_tools: ['read', 'bash'] }]
    await createChildRunner(env({ definitions: narrow, parentTools: () => ({ read: {} }) as never }))('n', {
      subagent_name: 'explorer',
      description: 'd',
    })
    // `bash` is outside the parent's tools, so it is intersected away: the
    // settings add a prompt block and nothing else.
    expect(runSubagent.mock.calls[0][0].resolved.allowedTools).toEqual(['read'])
  })
})
