import { describe, it, expect } from 'vitest'
import {
  renderNotRetried,
  runTeam,
  type TaskResult,
  type TeamState,
  type TeamTask,
} from '@/lib/coworkTeam'
import {
  DECISION_WINDOW_MS,
  TeamControl,
  type ControlRequest,
  type ControlResult,
} from '@/lib/coworkTeamControl'

const task = (id: string, dependsOn: string[] = [], extra: Partial<TeamTask> = {}): TeamTask => ({
  id,
  description: `do ${id}`,
  dependsOn,
  writes: [],
  ...extra,
})

/** Waits until `check` holds, polling the microtask queue and timers. */
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition never held')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('runTeam with a control (AH-111)', () => {
  it('holds a failed team, restarts the failed task and runs what it was blocking', async () => {
    const graph = [task('a'), task('b', ['a'])]
    const calls: string[] = []
    let failA = true
    const control = new TeamControl()
    let state: TeamState = {}
    const decisions: Array<[ControlRequest, ControlResult]> = []
    const done = runTeam(graph, {
      control,
      decisionWindowMs: DECISION_WINDOW_MS,
      onState: (s) => (state = s),
      onControl: (r, res) => decisions.push([r, res]),
      runTask: async (t): Promise<TaskResult> => {
        calls.push(t.id)
        const ok = !(t.id === 'a' && failA)
        return { taskId: t.id, ok, output: ok ? `${t.id} done` : 'broke', producedBy: t.id }
      },
    })
    await until(() => state.a?.status === 'failed' && state.b?.status === 'blocked')
    // Held for a decision, not ended.
    let ended = false
    void done.then(() => (ended = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(ended).toBe(false)

    failA = false
    control.request({ kind: 'restart', taskId: 'a' })
    const outcome = await done
    expect(calls).toEqual(['a', 'a', 'b'])
    expect(decisions[0][1]).toEqual({ ok: true })
    expect(outcome.ok && outcome.report.allDone).toBe(true)
    expect(outcome.ok && outcome.state).toEqual({ a: { status: 'completed' }, b: { status: 'completed' } })
  })

  it('replaces a failed task with another agent and brief', async () => {
    const graph = [task('a')]
    const seen: TeamTask[] = []
    const control = new TeamControl()
    let state: TeamState = {}
    const done = runTeam(graph, {
      control,
      decisionWindowMs: DECISION_WINDOW_MS,
      onState: (s) => (state = s),
      runTask: async (t): Promise<TaskResult> => {
        seen.push(t)
        const ok = t.subagentName === 'reviewer'
        return { taskId: t.id, ok, output: ok ? 'fixed' : 'no', producedBy: t.id }
      },
    })
    await until(() => state.a?.status === 'failed')
    control.request({ kind: 'replace', taskId: 'a', with: { subagentName: 'reviewer', description: 'fix it properly' } })
    const outcome = await done
    expect(seen.map((t) => [t.subagentName, t.description])).toEqual([
      [undefined, 'do a'],
      ['reviewer', 'fix it properly'],
    ])
    expect(outcome.ok && outcome.report.allDone).toBe(true)
    // The caller's graph is unchanged.
    expect(graph[0]).toEqual(task('a'))
  })

  it('refuses a request for a task that did not fail, and ends when finished', async () => {
    const graph = [task('a'), task('b')]
    const control = new TeamControl()
    let state: TeamState = {}
    const decisions: Array<[ControlRequest, ControlResult]> = []
    const done = runTeam(graph, {
      control,
      decisionWindowMs: DECISION_WINDOW_MS,
      onState: (s) => (state = s),
      onControl: (r, res) => decisions.push([r, res]),
      runTask: async (t): Promise<TaskResult> => ({ taskId: t.id, ok: t.id === 'b', output: '', producedBy: t.id }),
    })
    await until(() => state.a?.status === 'failed' && state.b?.status === 'completed')
    control.request({ kind: 'restart', taskId: 'b' })
    control.request({ kind: 'finish' })
    const outcome = await done
    expect(outcome.ok && outcome.decision).toBe('finished')
    expect(decisions.map(([r, res]) => [r.kind, res.ok])).toEqual([
      ['restart', false],
      ['finish', true],
    ])
    expect(decisions[0][1]).toMatchObject({ refusal: { kind: 'not-failed' } })
    expect(outcome.ok && outcome.report.allDone).toBe(false)
    // A request after the team ended is refused, not dropped.
    control.request({ kind: 'restart', taskId: 'a' })
    expect(control.finished).toBe(true)
  })

  it('ends a held team on its own when no decision comes within the window', async () => {
    const control = new TeamControl()
    const outcome = await runTeam([task('a'), task('b', ['a'])], {
      control,
      decisionWindowMs: 20,
      runTask: async (t): Promise<TaskResult> => ({ taskId: t.id, ok: false, output: 'no', producedBy: t.id }),
    })
    expect(outcome.ok && outcome.decision).toBe('window-elapsed')
    expect(outcome.ok && outcome.state).toEqual({ a: { status: 'failed' }, b: { status: 'blocked' } })
    expect(control.finished).toBe(true)
  })

  it('ends a held team when the run is stopped', async () => {
    const stop = new AbortController()
    const control = new TeamControl()
    let state: TeamState = {}
    const done = runTeam([task('a')], {
      control,
      decisionWindowMs: DECISION_WINDOW_MS,
      signal: stop.signal,
      onState: (s) => (state = s),
      runTask: async (t): Promise<TaskResult> => ({ taskId: t.id, ok: false, output: 'no', producedBy: t.id }),
    })
    await until(() => state.a?.status === 'failed')
    stop.abort()
    const outcome = await done
    expect(outcome.ok && outcome.report.allDone).toBe(false)
    expect(outcome.ok && outcome.decision).toBe('stopped')
  })

  it('without a control, a failed team ends at once as before', async () => {
    const outcome = await runTeam([task('a'), task('b', ['a'])], {
      runTask: async (t): Promise<TaskResult> => ({ taskId: t.id, ok: false, output: 'no', producedBy: t.id }),
    })
    expect(outcome.ok && outcome.state).toEqual({ a: { status: 'failed' }, b: { status: 'blocked' } })
  })
})

describe('a team with failures and no decision window', () => {
  it('reports the failure at once and says it was not retried', async () => {
    const control = new TeamControl()
    const started = Date.now()
    const outcome = await runTeam([task('a')], {
      runTask: async (t): Promise<TaskResult> => ({
        taskId: t.id,
        ok: false,
        output: 'provider unreachable\nstack...',
        producedBy: t.id,
      }),
      control,
    })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(outcome.ok && outcome.decision).toBe('not-retried')
    if (!outcome.ok) throw new Error('refused')
    expect(renderNotRetried(outcome.report)).toBe(
      'a failed (provider unreachable). Not retried automatically; re-dispatch it if needed.'
    )
  })
  it('pauses: running agents finish, nothing new starts until resume', async () => {
    const control = new TeamControl()
    const started: string[] = []
    const gate: Record<string, () => void> = {}
    let state: TeamState = {}
    const paused: boolean[] = []
    const done = runTeam([task('a'), task('b', ['a'])], {
      control,
      onState: (s) => (state = s),
      onPause: (p) => paused.push(p),
      runTask: (t): Promise<TaskResult> => {
        started.push(t.id)
        return new Promise((resolve) => {
          gate[t.id] = () => resolve({ taskId: t.id, ok: true, output: t.id, producedBy: t.id })
        })
      },
    })
    await until(() => state.a?.status === 'running')
    control.request({ kind: 'pause' })
    await until(() => control.paused)
    gate.a()
    await until(() => state.a?.status === 'completed')
    await new Promise((r) => setTimeout(r, 30))
    expect(started).toEqual(['a'])
    expect(state.b?.status).toBe('pending')
    control.request({ kind: 'resume' })
    await until(() => state.b?.status === 'running')
    gate.b()
    const outcome = await done
    expect(started).toEqual(['a', 'b'])
    expect(paused).toEqual([true, false])
    expect(outcome.ok && outcome.report.allDone).toBe(true)
    expect(control.paused).toBe(false)
  })

  it('restarts a running task: its attempt is stopped, discarded and run again', async () => {
    const control = new TeamControl()
    let state: TeamState = {}
    let attempts = 0
    const done = runTeam([task('a'), task('b', ['a'])], {
      control,
      onState: (s) => (state = s),
      runTask: (t, signal): Promise<TaskResult> => {
        if (t.id === 'a') attempts += 1
        if (t.id === 'a' && attempts === 1) {
          return new Promise((resolve) =>
            signal.addEventListener('abort', () =>
              resolve({ taskId: 'a', ok: false, output: 'cancelled', producedBy: 'a' })
            )
          )
        }
        return Promise.resolve({ taskId: t.id, ok: true, output: `${t.id} ok`, producedBy: t.id })
      },
    })
    await until(() => state.a?.status === 'running')
    control.request({ kind: 'restart', taskId: 'a' })
    const outcome = await done
    expect(attempts).toBe(2)
    // The stopped attempt is not a failure, and b was never blocked by it.
    expect(outcome.ok && outcome.state).toEqual({ a: { status: 'completed' }, b: { status: 'completed' } })
    expect(outcome.ok && outcome.report.failed).toEqual([])
  })

  it('a stopped paused team ends instead of waiting', async () => {
    const stop = new AbortController()
    const control = new TeamControl()
    control.request({ kind: 'pause' })
    const done = runTeam([task('a')], {
      control,
      signal: stop.signal,
      runTask: async (t): Promise<TaskResult> => ({ taskId: t.id, ok: true, output: '', producedBy: t.id }),
    })
    await new Promise((r) => setTimeout(r, 20))
    stop.abort()
    const outcome = await done
    expect(outcome.ok && outcome.report.unfinished).toEqual(['a'])
  })
})
