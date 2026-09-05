import { describe, expect, it } from 'vitest'
import {
  assembleReport,
  conflicts,
  danglingDependencies,
  findCycle,
  initialState,
  readyTasks,
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
    const report = assembleReport(tasks, [result('a', true), result('b', false)])

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
    const report = assembleReport([task('a')], [
      result('a', true),
      result('ghost', true),
    ])

    expect(report.completed.map((r) => r.taskId)).toEqual(['a'])
    expect(report.allDone).toBe(true)
  })
})
