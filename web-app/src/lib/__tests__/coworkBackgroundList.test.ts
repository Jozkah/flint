import { describe, it, expect } from 'vitest'
import {
  backgroundTasksOf,
  dismissBackground,
  emptyActivityState,
  isBackgroundTask,
  startTask,
  startWorkflow,
  taskIdFor,
  updateTask,
  type ActivityState,
  type ActivityTask,
} from '../coworkActivity'
import { statusLine } from '../coworkSubagentStats'

const task = (over: Partial<ActivityTask>): ActivityTask => {
  const callId = over.callId ?? 'c'
  return {
    id: taskIdFor('s1', 'w1', callId),
    callId,
    sessionId: 's1',
    workflowId: 'w1',
    kind: 'agent',
    title: 'explorer',
    status: 'running',
    startedAt: 100,
    ...over,
  }
}

const stateWith = (...tasks: ActivityTask[]): ActivityState =>
  tasks.reduce(
    (s, t) => startTask(s, t),
    startWorkflow(emptyActivityState(), {
      id: 'w1',
      sessionId: 's1',
      title: 'run',
      startedAt: 0,
      phases: [],
    })
  )

describe('which tasks are background tasks', () => {
  it('lists background agents and backgrounded jobs, and nothing the parent waited for', () => {
    expect(isBackgroundTask(task({ background: true }))).toBe(true)
    expect(isBackgroundTask(task({ kind: 'shell', jobId: 'bash-3' }))).toBe(true)
    // A foreground subagent and a shell still inside its tool call.
    expect(isBackgroundTask(task({}))).toBe(false)
    expect(isBackgroundTask(task({ kind: 'shell' }))).toBe(false)
  })

  it('is empty until something is started in the background', () => {
    const state = stateWith(task({ callId: 'fg' }), task({ callId: 'sh', kind: 'shell' }))
    expect(backgroundTasksOf(state, 's1')).toEqual({ running: [], finished: [] })
  })

  it('splits running from finished, newest first, per session', () => {
    const state = stateWith(
      task({ callId: 'old', background: true, startedAt: 10 }),
      task({ callId: 'new', background: true, startedAt: 50 }),
      task({ callId: 'done', background: true, status: 'done', endedAt: 90 }),
      task({ callId: 'other', background: true, sessionId: 's2', workflowId: 'w2' })
    )
    const { running, finished } = backgroundTasksOf(state, 's1')
    expect(running.map((t) => t.callId)).toEqual(['new', 'old'])
    expect(finished.map((t) => t.callId)).toEqual(['done'])
  })

  it('moves a task from running to finished as it ends', () => {
    let state = stateWith(task({ callId: 'a', background: true }))
    expect(backgroundTasksOf(state, 's1').running).toHaveLength(1)
    state = updateTask(state, taskIdFor('s1', 'w1', 'a'), { status: 'done', endedAt: 200 })
    const view = backgroundTasksOf(state, 's1')
    expect(view.running).toHaveLength(0)
    expect(view.finished).toHaveLength(1)
  })
})

describe('clearing', () => {
  const base = () =>
    stateWith(
      task({ callId: 'run', background: true }),
      task({ callId: 'f1', background: true, status: 'done', endedAt: 5 }),
      task({ callId: 'f2', background: true, status: 'error', endedAt: 6, output: 'kept' })
    )

  it('hides every finished row and leaves running ones alone', () => {
    const next = dismissBackground(base(), { sessionId: 's1' })
    const view = backgroundTasksOf(next, 's1')
    expect(view.finished).toHaveLength(0)
    expect(view.running).toHaveLength(1)
  })

  it('deletes nothing: the record, its output and the Tasks panel row stay', () => {
    const next = dismissBackground(base(), { sessionId: 's1' })
    const kept = next.tasks[taskIdFor('s1', 'w1', 'f2')]
    expect(kept).toBeDefined()
    expect(kept.output).toBe('kept')
    expect(Object.keys(next.tasks)).toHaveLength(3)
  })

  it('dismisses one row by id, and never a running one', () => {
    const one = dismissBackground(base(), { id: taskIdFor('s1', 'w1', 'f1') })
    expect(backgroundTasksOf(one, 's1').finished.map((t) => t.callId)).toEqual(['f2'])
    const running = dismissBackground(base(), { id: taskIdFor('s1', 'w1', 'run') })
    expect(backgroundTasksOf(running, 's1').running).toHaveLength(1)
  })

  it('is a no-op (same object) when there is nothing to hide', () => {
    const state = stateWith(task({ callId: 'run', background: true }))
    expect(dismissBackground(state, { sessionId: 's1' })).toBe(state)
  })

  it('leaves the list empty, so the tab goes away, then returns on the next spawn', () => {
    let state = dismissBackground(
      stateWith(task({ callId: 'f', background: true, status: 'done', endedAt: 5 })),
      { sessionId: 's1' }
    )
    const view = backgroundTasksOf(state, 's1')
    expect(view.running.length + view.finished.length).toBe(0)
    state = startTask(state, task({ callId: 'again', background: true }))
    expect(backgroundTasksOf(state, 's1').running).toHaveLength(1)
  })
})

describe('statusLine', () => {
  const running = (transcript: ActivityTask['transcript']) =>
    statusLine({ status: 'running', kind: 'agent', transcript })

  it('names what the latest unfinished tool call is doing', () => {
    expect(running([{ role: 'tool', name: 'bash', content: '', toolState: 'running' }])).toBe('command')
    expect(running([{ role: 'tool', name: 'read', content: '', status: 'running' }])).toBe('reading')
    expect(running([{ role: 'tool', name: 'grep', content: '', toolState: 'requested' }])).toBe('searching')
    expect(running([{ role: 'tool', name: 'weird', content: '', toolState: 'running' }])).toBe('tool')
  })

  it('says thinking when no call is in flight', () => {
    expect(running(undefined)).toBe('thinking')
    expect(running([{ role: 'tool', name: 'bash', content: '', toolState: 'succeeded' }])).toBe('thinking')
    expect(
      running([
        { role: 'tool', name: 'bash', content: '', toolState: 'running' },
        { role: 'assistant', content: 'done with that' },
      ])
    ).toBe('thinking')
  })

  it('reports how a finished task ended, and a running shell as a command', () => {
    expect(statusLine({ status: 'queued', kind: 'agent' })).toBe('queued')
    expect(statusLine({ status: 'done', kind: 'agent' })).toBe('finished')
    expect(statusLine({ status: 'error', kind: 'agent' })).toBe('failed')
    expect(statusLine({ status: 'cancelled', kind: 'agent' })).toBe('cancelled')
    expect(statusLine({ status: 'interrupted', kind: 'agent' })).toBe('cancelled')
    expect(statusLine({ status: 'running', kind: 'shell' })).toBe('command')
  })
})
