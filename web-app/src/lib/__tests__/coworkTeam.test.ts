import { describe, expect, it } from 'vitest'
import {
  MAX_TEAM_TASKS,
  assembleReport,
  conflicts,
  danglingDependencies,
  findCycle,
  initialState,
  parseTeamRequest,
  readyTasks,
  renderTeamReport,
  runTeam,
  settle,
  type TaskResult,
  type TeamTask,
} from '@/lib/coworkTeam'

const task = (
  id: string,
  dependsOn: string[] = [],
  writes: string[] = []
): TeamTask => ({ id, description: `do ${id}`, dependsOn, writes })

const result = (taskId: string, ok: boolean): TaskResult => ({
  taskId,
  ok,
  output: ok ? 'done' : 'it failed',
  producedBy: `child-${taskId}`,
})

describe('what can start', () => {
  it('starts only what has nothing left to wait for', () => {
    const tasks = [task('a'), task('b', ['a']), task('c')]

    expect(readyTasks(tasks, initialState(tasks)).map((t) => t.id)).toEqual([
      'a',
      'c',
    ])
  })

  it('dispatches in the same order every time', () => {
    // Deterministic dispatch is what makes a coordination failure reproducible
    // instead of something that happened once on someone's machine.
    const tasks = [task('c'), task('a'), task('b')]
    const ids = () => readyTasks(tasks, initialState(tasks)).map((t) => t.id)

    expect(ids()).toEqual(['a', 'b', 'c'])
    expect(ids()).toEqual(ids())
  })

  it('releases a dependent once its dependency completes', () => {
    const tasks = [task('a'), task('b', ['a'])]
    const state = settle(tasks, initialState(tasks), 'a', 'completed')

    expect(readyTasks(tasks, state).map((t) => t.id)).toEqual(['b'])
  })

  it('does not re-offer something already running', () => {
    const tasks = [task('a')]
    const state = { a: { status: 'running' as const, owner: 'child-1' } }

    expect(readyTasks(tasks, state)).toEqual([])
  })
})

describe('when something fails', () => {
  it('blocks what depended on it rather than leaving it pending', () => {
    // Pending would look schedulable while its precondition is permanently
    // gone, and a run ending with pending tasks reads as interrupted rather
    // than failed.
    const tasks = [task('a'), task('b', ['a'])]
    const state = settle(tasks, initialState(tasks), 'a', 'failed')

    expect(state.b.status).toBe('blocked')
    expect(readyTasks(tasks, state)).toEqual([])
  })

  it('blocks transitively, not just the immediate dependent', () => {
    const tasks = [task('a'), task('b', ['a']), task('c', ['b'])]
    const state = settle(tasks, initialState(tasks), 'a', 'failed')

    expect(state.b.status).toBe('blocked')
    expect(state.c.status).toBe('blocked')
  })

  it('leaves independent work alone', () => {
    // One child failing must not cancel the siblings that never needed it.
    const tasks = [task('a'), task('b', ['a']), task('c')]
    const state = settle(tasks, initialState(tasks), 'a', 'failed')

    expect(state.c.status).toBe('pending')
    expect(readyTasks(tasks, state).map((t) => t.id)).toEqual(['c'])
  })

  it('treats cancellation as blocking too', () => {
    const tasks = [task('a'), task('b', ['a'])]
    const state = settle(tasks, initialState(tasks), 'a', 'cancelled')

    expect(state.b.status).toBe('blocked')
  })
})

describe('graphs that cannot be run', () => {
  it('names a dependency nothing provides', () => {
    // Otherwise the task is permanently unrunnable and looks like a stall.
    expect(danglingDependencies([task('a', ['ghost'])])).toEqual(['ghost'])
  })

  it('finds a cycle rather than reporting nothing ready forever', () => {
    const cycle = findCycle([task('a', ['b']), task('b', ['a'])])

    expect(cycle).not.toBeNull()
    expect(cycle).toContain('a')
    expect(cycle).toContain('b')
  })

  it('reports the same cycle every time', () => {
    const tasks = [task('c', ['a']), task('a', ['b']), task('b', ['c'])]

    expect(findCycle(tasks)).toEqual(findCycle(tasks))
  })

  it('is quiet about a graph that is fine', () => {
    const tasks = [task('a'), task('b', ['a']), task('c', ['a'])]

    expect(findCycle(tasks)).toBeNull()
    expect(danglingDependencies(tasks)).toEqual([])
  })
})

describe('two children about to change the same file', () => {
  it('is caught before either has done the work', () => {
    const found = conflicts([
      task('a', [], ['src/index.ts']),
      task('b', [], ['src/index.ts']),
    ])

    expect(found).toEqual([{ path: 'src/index.ts', tasks: ['a', 'b'] }])
  })

  it('is not a conflict when one waits for the other', () => {
    // Two tasks touching one file is fine when they are ordered — calling that
    // a conflict would make the dependency mechanism pointless.
    expect(
      conflicts([
        task('a', [], ['src/index.ts']),
        task('b', ['a'], ['src/index.ts']),
      ])
    ).toEqual([])
  })

  it('is not a conflict across a transitive dependency', () => {
    expect(
      conflicts([
        task('a', [], ['x.ts']),
        task('b', ['a']),
        task('c', ['b'], ['x.ts']),
      ])
    ).toEqual([])
  })

  it('says nothing about tasks that write nothing', () => {
    expect(conflicts([task('a'), task('b')])).toEqual([])
  })

  it('reports every clashing path, in a stable order', () => {
    const found = conflicts([
      task('a', [], ['z.ts', 'a.ts']),
      task('b', [], ['a.ts', 'z.ts']),
    ])

    expect(found.map((c) => c.path)).toEqual(['a.ts', 'z.ts'])
  })
})

describe('the report the parent gives back', () => {
  it('never turns a missing result into a finished one', () => {
    // The rule the whole module exists to keep: a task nobody reported on is
    // unfinished, not assumed done.
    const tasks = [task('a'), task('b')]
    const report = assembleReport(tasks, [result('a', true)])

    expect(report.completed.map((r) => r.taskId)).toEqual(['a'])
    expect(report.unfinished).toEqual(['b'])
    expect(report.allDone).toBe(false)
  })

  it('keeps a failure a failure', () => {
    const tasks = [task('a'), task('b')]
    const report = assembleReport(tasks, [
      result('a', true),
      result('b', false),
    ])

    expect(report.failed.map((r) => r.taskId)).toEqual(['b'])
    expect(report.allDone).toBe(false)
  })

  it('says everything is done only when it is', () => {
    const tasks = [task('a'), task('b')]
    const report = assembleReport(tasks, [result('a', true), result('b', true)])

    expect(report.allDone).toBe(true)
    expect(report.unfinished).toEqual([])
  })

  it('carries who produced each answer', () => {
    // Provenance, so a claim in the summary can be traced to the child that
    // made it rather than read as the parent's own finding.
    const report = assembleReport([task('a')], [result('a', true)])

    expect(report.completed[0].producedBy).toBe('child-a')
  })

  it('reads the same way every time', () => {
    const tasks = [task('c'), task('a'), task('b')]
    const results = [result('c', true), result('a', true), result('b', false)]

    const first = assembleReport(tasks, results)
    const again = assembleReport(tasks, [...results].reverse())

    expect(first).toEqual(again)
    expect(first.completed.map((r) => r.taskId)).toEqual(['a', 'c'])
  })

  it('ignores a result for a task that is not in the graph', () => {
    // A stale result from a cancelled or superseded plan must not add itself
    // to the tally of work that was asked for.
    const report = assembleReport(
      [task('a')],
      [result('a', true), result('ghost', true)]
    )

    expect(report.completed.map((r) => r.taskId)).toEqual(['a'])
    expect(report.allDone).toBe(true)
  })
})

describe('running the graph', () => {
  const ok = (task: TeamTask): TaskResult => ({
    taskId: task.id,
    ok: true,
    output: `${task.id} done`,
    producedBy: task.id,
  })

  it('refuses a graph that cannot finish, before dispatching anything', async () => {
    // Starting it anyway would burn children on work already known to be
    // unreachable.
    const dispatched: string[] = []
    const outcome = await runTeam([task('a', ['ghost'])], {
      runTask: async (t) => {
        dispatched.push(t.id)
        return ok(t)
      },
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.refusal).toContain('ghost')
    expect(dispatched).toEqual([])
  })

  it('refuses two tasks that would change the same file, and says how to fix it', async () => {
    const outcome = await runTeam(
      [task('a', [], ['src/x.ts']), task('b', [], ['src/x.ts'])],
      { runTask: async (t) => ok(t) }
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.refusal).toContain('src/x.ts')
    expect(outcome.ok === false && outcome.refusal).toContain('depends_on')
  })

  it('runs a dependency before what depends on it', async () => {
    const order: string[] = []
    const outcome = await runTeam([task('b', ['a']), task('a')], {
      runTask: async (t) => {
        order.push(t.id)
        return ok(t)
      },
    })

    expect(order).toEqual(['a', 'b'])
    expect(outcome.ok && outcome.report.allDone).toBe(true)
  })

  it('runs independent tasks at the same time', async () => {
    let peak = 0
    let live = 0
    const outcome = await runTeam([task('a'), task('b'), task('c')], {
      runTask: async (t) => {
        live += 1
        peak = Math.max(peak, live)
        await new Promise((r) => setTimeout(r, 5))
        live -= 1
        return ok(t)
      },
    })

    expect(peak).toBeGreaterThan(1)
    expect(outcome.ok && outcome.report.completed).toHaveLength(3)
  })

  it('honours the parallelism limit', async () => {
    let peak = 0
    let live = 0
    await runTeam([task('a'), task('b'), task('c'), task('d')], {
      maxParallel: 2,
      runTask: async (t) => {
        live += 1
        peak = Math.max(peak, live)
        await new Promise((r) => setTimeout(r, 5))
        live -= 1
        return ok(t)
      },
    })

    expect(peak).toBe(2)
  })

  it('never dispatches what depended on a failure', async () => {
    const dispatched: string[] = []
    const outcome = await runTeam([task('a'), task('b', ['a']), task('c')], {
      runTask: async (t) => {
        dispatched.push(t.id)
        return t.id === 'a' ? { ...ok(t), ok: false } : ok(t)
      },
    })

    expect(dispatched).toContain('c')
    expect(dispatched).not.toContain('b')
    expect(outcome.ok && outcome.report.unfinished).toEqual(['b'])
    expect(outcome.ok && outcome.report.allDone).toBe(false)
  })

  it('treats a child that threw as a failed task, not a crashed team', async () => {
    // The point of running several is that one going wrong does not take the
    // rest with it.
    const outcome = await runTeam([task('a'), task('b')], {
      runTask: async (t) => {
        if (t.id === 'a') throw new Error('the child exploded')
        return ok(t)
      },
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.report.failed[0].output).toContain('exploded')
    expect(outcome.ok && outcome.report.completed.map((r) => r.taskId)).toEqual(
      ['b']
    )
  })

  it('stops dispatching when the team is cancelled', async () => {
    const control = new AbortController()
    const dispatched: string[] = []
    const outcome = await runTeam(
      [task('a'), task('b', ['a']), task('c', ['b'])],
      {
        signal: control.signal,
        maxParallel: 1,
        runTask: async (t) => {
          dispatched.push(t.id)
          control.abort()
          return ok(t)
        },
      }
    )

    expect(dispatched).toEqual(['a'])
    // Never dispatched is unfinished, not cancelled: reporting them as
    // cancelled would claim a decision nobody made about them.
    expect(outcome.ok && outcome.report.unfinished).toEqual(['b', 'c'])
  })

  it('passes each child a signal the team cancellation reaches', async () => {
    const control = new AbortController()
    let sawAbort = false
    await runTeam([task('a')], {
      signal: control.signal,
      runTask: (t, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            sawAbort = true
            resolve({ ...ok(t), ok: false, output: 'cancelled' })
          })
          control.abort()
        }),
    })

    expect(sawAbort).toBe(true)
  })

  it('reports progress as tasks settle', async () => {
    const seen: string[] = []
    await runTeam([task('a'), task('b', ['a'])], {
      runTask: async (t) => ok(t),
      onState: (state) => seen.push(state.a.status),
    })

    expect(seen).toContain('running')
    expect(seen).toContain('completed')
  })
})

describe('what the dispatching agent is told', () => {
  it('names every task, including the ones that never ran', () => {
    // A summary listing only successes would let the agent carry on as though
    // the rest had happened.
    const rendered = renderTeamReport({
      completed: [
        { taskId: 'a', ok: true, output: 'found it', producedBy: 'a' },
      ],
      failed: [
        { taskId: 'b', ok: false, output: 'could not read', producedBy: 'b' },
      ],
      unfinished: ['c'],
      allDone: false,
    })

    expect(rendered).toContain('a — completed')
    expect(rendered).toContain('b — FAILED')
    expect(rendered).toContain('did not run: c')
    expect(rendered).toContain('1 completed, 1 failed, 1 did not run')
  })

  it('says so plainly when everything finished', () => {
    const rendered = renderTeamReport({
      completed: [{ taskId: 'a', ok: true, output: 'x', producedBy: 'a' }],
      failed: [],
      unfinished: [],
      allDone: true,
    })

    expect(rendered).toContain('All 1 tasks completed')
  })
})

describe('reading a team request', () => {
  it('needs tasks that a child could act on alone', () => {
    expect(parseTeamRequest({})).toContain('tasks')
    expect(parseTeamRequest({ tasks: [] })).toContain('non-empty')
    expect(parseTeamRequest({ tasks: [{ id: 'a' }] })).toContain('description')
    expect(parseTeamRequest({ tasks: [{ description: 'x' }] })).toContain('id')
  })

  it('refuses a duplicate id rather than silently losing one', () => {
    const parsed = parseTeamRequest({
      tasks: [
        { id: 'a', description: 'one' },
        { id: 'a', description: 'two' },
      ],
    })

    expect(parsed).toContain('twice')
  })

  it('caps how many tasks one team may hold', () => {
    const many = Array.from({ length: MAX_TEAM_TASKS + 1 }, (_, i) => ({
      id: `t${i}`,
      description: 'x',
    }))

    expect(parseTeamRequest({ tasks: many })).toContain('split the work')
  })

  it('keeps dependencies and declared writes', () => {
    const parsed = parseTeamRequest({
      tasks: [
        { id: 'a', description: 'one', writes: ['x.ts', 7] },
        { id: 'b', description: 'two', depends_on: ['a'] },
      ],
    })

    expect(Array.isArray(parsed)).toBe(true)
    const tasks = parsed as TeamTask[]
    expect(tasks[0].writes).toEqual(['x.ts'])
    expect(tasks[1].dependsOn).toEqual(['a'])
  })

  it('reads a request for a checkout of its own, and only a real one', () => {
    const parsed = parseTeamRequest({
      tasks: [
        { id: 'a', description: 'one', isolate: true },
        { id: 'b', description: 'two' },
        { id: 'c', description: 'three', isolate: 'yes' },
      ],
    }) as TeamTask[]

    expect(parsed[0].isolate).toBe(true)
    expect(parsed[1].isolate).toBeUndefined()
    // Anything that is not the boolean is not a request: isolation costs a
    // worktree and a grant, so it is granted on a clear yes or not at all.
    expect(parsed[2].isolate).toBeUndefined()
  })

  it('names an isolated task’s checkout in the report', () => {
    const report = assembleReport(
      [
        { id: 'a', description: 'x', dependsOn: [], writes: [], isolate: true },
        { id: 'b', description: 'y', dependsOn: [], writes: [] },
      ],
      [
        {
          taskId: 'a',
          ok: true,
          output: 'done',
          producedBy: 'a',
          destination: '/data/worktrees/a',
        },
        { taskId: 'b', ok: true, output: 'done', producedBy: 'b' },
      ]
    )

    const rendered = renderTeamReport(report)
    expect(rendered).toContain(
      'a — completed (in its own checkout: /data/worktrees/a)'
    )
    // The one that worked in the run's own destination says nothing extra, so
    // the distinction is visible rather than uniform.
    expect(rendered).toContain('b — completed\n')
  })
})
