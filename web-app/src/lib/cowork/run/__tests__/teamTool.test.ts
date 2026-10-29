import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  conflictRequest: vi.fn(),
  planDestinations: vi.fn(),
  runTeam: vi.fn(),
  patchTask: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  release: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/hooks/useTeamConflictRequests', () => ({
  useTeamConflictRequests: { getState: () => ({ request: m.conflictRequest }) },
}))
vi.mock('@/hooks/useTeamControls', () => ({
  useTeamControls: { getState: () => ({ register: m.register, unregister: m.unregister }) },
}))
vi.mock('@/hooks/useCoworkActivity', () => ({
  useCoworkActivity: { getState: () => ({ patchTask: m.patchTask, tasks: {} }) },
}))
vi.mock('@/lib/coworkActivityRecorder', () => ({ recordAgentDispatch: vi.fn() }))
vi.mock('@/lib/coworkTeamDestinations', async (orig) => ({
  ...(await orig<typeof import('@/lib/coworkTeamDestinations')>()),
  planDestinations: m.planDestinations,
}))
vi.mock('@/lib/coworkTeam', async (orig) => ({
  ...(await orig<typeof import('@/lib/coworkTeam')>()),
  runTeam: m.runTeam,
  renderTeamReport: () => 'REPORT',
  teamProgress: () => 'progress',
}))

import { createTeamTool } from '../teamTool'

const make = () => {
  const dispatchChild = vi.fn()
  const tool = createTeamTool({
    sid: 's1',
    runId: 'r1',
    run: { sessionId: 's1', runId: 'r1', title: 't', model: 'm' },
    signal: new AbortController().signal,
    folder: '/proj',
    modelId: 'm',
    canIsolate: false,
    dataFolder: vi.fn(async () => '/data'),
    anchorMessageId: () => undefined,
    dispatchChild: dispatchChild as never,
  })
  return { tool, dispatchChild }
}

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  description: `do ${id}`,
  ...extra,
})

describe('createTeamTool, characterized', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.planDestinations.mockResolvedValue({ ok: true, byTask: new Map(), release: m.release })
  })

  it('refuses input that is not a team', async () => {
    const out = await make().tool('c1', {})
    expect(out).toEqual({ output: expect.stringMatching(/^ERROR: team needs/), isError: true })
    expect(m.planDestinations).not.toHaveBeenCalled()
  })

  it('refuses a graph that cannot run before provisioning anything', async () => {
    const out = await make().tool('c1', { tasks: [task('a', { depends_on: ['missing'] })] })
    expect(out.isError).toBe(true)
    expect(out.output).toMatch(/^ERROR: /)
    expect(m.planDestinations).not.toHaveBeenCalled()
  })

  it('asks about overlapping writes and stops when the user cancels', async () => {
    m.conflictRequest.mockResolvedValue({ kind: 'cancel' })
    const out = await make().tool('c1', {
      tasks: [task('a', { writes: ['src/x.ts'] }), task('b', { writes: ['src/x.ts'] })],
    })
    expect(m.conflictRequest).toHaveBeenCalledOnce()
    expect(out.isError).toBe(true)
    expect(out.output).toContain('the user chose not to run these tasks')
    expect(out.output).toContain('src/x.ts')
    expect(m.planDestinations).not.toHaveBeenCalled()
  })

  it('returns the destination refusal when checkouts cannot be planned', async () => {
    m.planDestinations.mockResolvedValue({ ok: false, refusal: 'no isolation' })
    const out = await make().tool('c1', { tasks: [task('a')] })
    expect(out).toEqual({ output: 'ERROR: no isolation', isError: true })
    expect(m.runTeam).not.toHaveBeenCalled()
  })

  it('records the team, reports a refused run as an error, and always releases', async () => {
    m.runTeam.mockResolvedValue({ ok: false, refusal: 'cycle' })
    const out = await make().tool('c1', { tasks: [task('a')] })
    expect(out).toEqual({ output: 'ERROR: cycle', isError: true })
    expect(m.register).toHaveBeenCalledOnce()
    expect(m.unregister).toHaveBeenCalledOnce()
    expect(m.release).toHaveBeenCalledOnce()
    expect(m.patchTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'error', output: 'cycle' })
    )
  })

  it('a partial team is an error result carrying the report', async () => {
    m.runTeam.mockResolvedValue({
      ok: true,
      report: { allDone: false, tasks: [] },
      state: {},
      decision: undefined,
    })
    const out = await make().tool('c1', { tasks: [task('a')] })
    expect(out).toEqual({ output: 'REPORT', isError: true })
    expect(m.patchTask).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'error' })
    )
  })
})
