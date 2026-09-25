import { describe, expect, it } from 'vitest'
import {
  childrenOf,
  currentPhase,
  dismissFinished,
  emptyActivityState,
  findTaskByJob,
  endWorkflow,
  forgetSession,
  isCancellable,
  observePhase,
  phaseIdFor,
  progressOf,
  rootTasks,
  sessionIsActive,
  sessionTotals,
  sessionWorkflows,
  settleOnLoad,
  settleRunOrphans,
  settleSessionWork,
  survivesRunEnd,
  taskIdFor,
  startTask,
  startWorkflow,
  taskElapsedMs,
  tasksOfPhase,
  updateTask,
  workflowAnchoredAt,
  workflowStatus,
  isLive,
  workflowView,
  type ActivityState,
  type ActivityTask,
  type ActivityWorkflow,
  type WorkflowStatus,
} from '@/lib/coworkActivity'

const SESSION = 's-1'
const OTHER_SESSION = 's-2'
const WORKFLOW = 'run-1'
const T0 = 1_700_000_000_000

const workflow = (over: Partial<ActivityWorkflow> = {}): ActivityWorkflow => ({
  id: WORKFLOW,
  sessionId: SESSION,
  title: 'refactor the parser',
  startedAt: T0,
  phases: [],
  ...over,
})

/** Built through `taskIdFor`, the way the recorder builds them. */
const task = (over: Partial<ActivityTask> = {}): ActivityTask => {
  const callId = over.callId ?? over.id ?? 'call-1'
  const sessionId = over.sessionId ?? SESSION
  const workflowId = over.workflowId ?? WORKFLOW
  return {
    ...base(callId, sessionId, workflowId),
    ...over,
    callId,
    sessionId,
    workflowId,
    id: taskIdFor(sessionId, workflowId, callId),
  }
}

const base = (
  callId: string,
  sessionId: string,
  workflowId: string
): ActivityTask => ({
  id: taskIdFor(sessionId, workflowId, callId),
  callId,
  sessionId,
  workflowId,
  kind: 'agent',
  title: 'explorer',
  status: 'running',
  startedAt: T0,
})

/** The canonical id for a call within the default workflow. */
const idOf = (callId: string, sessionId = SESSION, workflowId = WORKFLOW) =>
  taskIdFor(sessionId, workflowId, callId)

/** A state with one workflow and the given tasks. */
const withTasks = (...tasks: ActivityTask[]): ActivityState =>
  tasks.reduce(
    (state, one) => startTask(state, one),
    startWorkflow(emptyActivityState(), workflow())
  )

describe('recording work', () => {
  it('records a workflow once, ignoring a repeat of the same run', () => {
    const first = startWorkflow(emptyActivityState(), workflow())
    const again = startWorkflow(first, workflow({ title: 'different' }))
    expect(again).toBe(first)
    expect(again.workflows[WORKFLOW].title).toBe('refactor the parser')
  })

  it('records a task once, ignoring a repeat of the same call id', () => {
    const first = withTasks(task())
    const again = startTask(first, task({ title: 'renamed' }))
    expect(again).toBe(first)
    expect(again.tasks[idOf('call-1')].title).toBe('explorer')
  })

  it('keeps the metadata captured at dispatch', () => {
    // The dispatch is the only moment this is known; nothing downstream can
    // recover which model a finished subagent actually ran on.
    const state = withTasks(
      task({
        model: 'jan-nano-4b',
        agentName: 'explorer',
        description: 'map the lexer',
      })
    )
    expect(state.tasks[idOf('call-1')]).toMatchObject({
      model: 'jan-nano-4b',
      agentName: 'explorer',
      description: 'map the lexer',
    })
  })
})

describe('phases', () => {
  it('assigns a stable id the first time a phase is observed', () => {
    const state = startWorkflow(emptyActivityState(), workflow())
    const first = observePhase(state, WORKFLOW, { name: 'Implement', index: 1 })
    expect(first.phaseId).toBe(phaseIdFor(WORKFLOW, 0))
    expect(first.state.workflows[WORKFLOW].phases).toEqual([
      { id: phaseIdFor(WORKFLOW, 0), name: 'Implement', index: 1 },
    ])
  })

  it('returns the same id for a phase already observed', () => {
    const state = startWorkflow(emptyActivityState(), workflow())
    const first = observePhase(state, WORKFLOW, { name: 'Implement', index: 1 })
    const second = observePhase(first.state, WORKFLOW, {
      name: 'Implement',
      index: 1,
    })
    expect(second.phaseId).toBe(first.phaseId)
    expect(second.state).toBe(first.state)
  })

  it('keeps the name a phase was recorded with when the list is rewritten', () => {
    // `todo_write` replaces the list wholesale. Renaming history would move
    // work that has already run under a heading it never ran under.
    const state = startWorkflow(emptyActivityState(), workflow())
    const first = observePhase(state, WORKFLOW, { name: 'Implement', index: 1 })
    const renamed = observePhase(first.state, WORKFLOW, {
      name: 'Implement, revised',
      index: 1,
    })
    expect(renamed.state.workflows[WORKFLOW].phases[0].name).toBe('Implement')
  })

  it('gives two phases of one workflow different ids', () => {
    const state = startWorkflow(emptyActivityState(), workflow())
    const a = observePhase(state, WORKFLOW, { name: 'Scan', index: 0 })
    const b = observePhase(a.state, WORKFLOW, { name: 'Fix', index: 1 })
    expect(a.phaseId).not.toBe(b.phaseId)
  })

  it('records nothing for a workflow it does not know', () => {
    const state = emptyActivityState()
    const result = observePhase(state, 'nope', { name: 'Scan', index: 0 })
    expect(result.phaseId).toBeUndefined()
    expect(result.state).toBe(state)
  })

  it('groups a workflow’s tasks under the phase they were dispatched in', () => {
    const state = withTasks(
      task({ id: 'a', phaseId: 'run-1:p0' }),
      task({ id: 'b', phaseId: 'run-1:p1' }),
      task({ id: 'c', phaseId: 'run-1:p0' })
    )
    const tasks = Object.values(state.tasks)
    expect(tasksOfPhase(tasks, 'run-1:p0').map((t) => t.callId)).toEqual(['a', 'c'])
  })
})

describe('updating a task', () => {
  it('merges an update onto a live task', () => {
    const state = updateTask(withTasks(task()), idOf('call-1'), {
      status: 'done',
      endedAt: T0 + 5,
    })
    expect(state.tasks[idOf('call-1')].status).toBe('done')
  })

  it('will not resurrect a task that has already finished', () => {
    // A stream torn down mid-cancel still emits its end event. Taking it would
    // erase the fact that the user stopped this.
    const cancelled = updateTask(withTasks(task()), idOf('call-1'), {
      status: 'cancelled',
      endedAt: T0 + 1,
      detail: 'cancelled by you',
    })
    const late = updateTask(cancelled, idOf('call-1'), {
      status: 'running',
      endedAt: undefined,
    })
    expect(late.tasks[idOf('call-1')].status).toBe('cancelled')
    expect(late.tasks[idOf('call-1')].detail).toBe('cancelled by you')
    expect(late.tasks[idOf('call-1')].endedAt).toBe(T0 + 1)
  })

  it('still takes the output a killed task produced before it died', () => {
    // The reason to keep the record at all: a killed command's partial output
    // is the useful part.
    const cancelled = updateTask(
      withTasks(task({ kind: 'shell' })),
      idOf('call-1'),
      { status: 'cancelled' }
    )
    const settled = updateTask(cancelled, idOf('call-1'), {
      status: 'done',
      output: 'half a line',
    })
    expect(settled.tasks[idOf('call-1')].status).toBe('cancelled')
    expect(settled.tasks[idOf('call-1')].output).toBe('half a line')
  })

  it('ignores an update to a task it does not know', () => {
    const state = withTasks(task())
    expect(updateTask(state, 'nope', { status: 'done' })).toBe(state)
  })
})

describe('workflow status, derived from its children', () => {
  const statusOf = (...tasks: ActivityTask[]): WorkflowStatus =>
    workflowStatus(workflow(), tasks)

  it('is running while any child is running', () => {
    expect(
      statusOf(
        task({ id: 'a', status: 'done' }),
        task({ id: 'b', status: 'running' })
      )
    ).toBe('running')
  })

  it('never reports finished while a child is still going', () => {
    // The parent must not be able to claim it is over before its work is.
    expect(
      workflowStatus(workflow({ endedAt: T0 + 9 }), [task({ status: 'running' })])
    ).toBe('running')
  })

  it('is queued while work waits for a slot in a live run', () => {
    expect(statusOf(task({ status: 'queued', waiting: 2 }))).toBe('queued')
  })

  it('treats a queue left behind by a finished run as cancelled', () => {
    // A run that is over cannot still be waiting for a slot; nothing will ever
    // start that work.
    expect(
      workflowStatus(workflow({ endedAt: T0 + 9 }), [
        task({ status: 'queued', waiting: 1 }),
      ])
    ).toBe('cancelled')
  })

  it('reports a failure ahead of the successes around it', () => {
    expect(
      statusOf(
        task({ id: 'a', status: 'done' }),
        task({ id: 'b', status: 'error' })
      )
    ).toBe('error')
  })

  it('reports cancelled when any child was stopped', () => {
    // Part of the workflow was stopped, so it did not complete. Reporting
    // "done" for a mixture would hide that — the documented precedence is
    // error, then cancelled, then done.
    expect(
      statusOf(
        task({ id: 'a', status: 'cancelled' }),
        task({ id: 'b', status: 'cancelled' })
      )
    ).toBe('cancelled')
    expect(
      statusOf(
        task({ id: 'a', status: 'cancelled' }),
        task({ id: 'b', status: 'done' })
      )
    ).toBe('cancelled')
  })

  it('reports a failure ahead of a cancellation', () => {
    expect(
      statusOf(
        task({ id: 'a', status: 'cancelled' }),
        task({ id: 'b', status: 'error' })
      )
    ).toBe('error')
  })

  it('is running while a live run has dispatched nothing yet', () => {
    expect(statusOf()).toBe('running')
  })

  it('finishes with errors when only commands failed in a completed run', () => {
    // "7 of 7 finished" with a red "Failed" over it read as the run failing;
    // a command that exited non-zero is part of the work the run did.
    const ended = workflow({ endedAt: T0 + 9 })
    const shell = (id: string, status: ActivityTask['status']) =>
      task({ id, kind: 'shell', status })
    expect(
      workflowStatus(ended, [shell('a', 'done'), shell('b', 'error'), shell('c', 'done')])
    ).toBe('partial')
    expect(isLive('partial')).toBe(false)
    // Still going: nothing is settled yet.
    expect(workflowStatus(workflow(), [shell('a', 'error')])).toBe('error')
    // A failed agent is a failure of the work, not a command's exit code.
    expect(
      workflowStatus(ended, [shell('a', 'error'), task({ id: 'b', status: 'error' })])
    ).toBe('error')
  })

  it('is done once a finished run has no live children left', () => {
    expect(workflowStatus(workflow({ endedAt: T0 + 9 }), [])).toBe('done')
  })
})

describe('progress', () => {
  it('measures finished work of any kind, not only success', () => {
    // A bar that a failed task can never advance is not progress.
    const progress = progressOf([
      task({ id: 'a', status: 'done' }),
      task({ id: 'b', status: 'error' }),
      task({ id: 'c', status: 'cancelled' }),
      task({ id: 'd', status: 'running' }),
    ])
    expect(progress).toMatchObject({
      total: 4,
      done: 1,
      error: 1,
      cancelled: 1,
      running: 1,
      finished: 3,
    })
    expect(progress.fraction).toBeCloseTo(0.75)
  })

  it('has no fraction with nothing to measure', () => {
    expect(progressOf([]).fraction).toBeNull()
  })

  it('sums the tokens and tool calls the children actually reported', () => {
    const progress = progressOf([
      task({ id: 'a', usage: { total_tokens: 120 }, toolCount: 3 }),
      task({ id: 'b', toolCount: 1 }),
    ])
    expect(progress.tokens).toBe(120)
    expect(progress.toolCalls).toBe(4)
  })
})

describe('the shape a surface renders', () => {
  it('lists each phase with the work dispatched under it', () => {
    let state = startWorkflow(emptyActivityState(), workflow())
    const scan = observePhase(state, WORKFLOW, { name: 'Scan', index: 0 })
    state = scan.state
    const fix = observePhase(state, WORKFLOW, { name: 'Fix', index: 1 })
    state = fix.state
    state = startTask(state, task({ id: 'a', phaseId: scan.phaseId }))
    state = startTask(state, task({ id: 'b', phaseId: fix.phaseId }))
    state = startTask(state, task({ id: 'loose' }))

    const view = workflowView(state, WORKFLOW)!
    expect(view.phases.map((p) => p.phase.name)).toEqual(['Scan', 'Fix'])
    expect(view.phases[0].tasks.map((t) => t.callId)).toEqual(['a'])
    expect(view.unphased.map((t) => t.callId)).toEqual(['loose'])
  })

  it('separates top-level work from work a task dispatched itself', () => {
    const parent = task({ id: 'parent' })
    const tasks = [parent, task({ id: 'child', parentTaskId: parent.id })]
    expect(rootTasks(tasks).map((t) => t.callId)).toEqual(['parent'])
    expect(childrenOf(tasks, parent.id).map((t) => t.callId)).toEqual(['child'])
  })

  it('orders a workflow’s tasks by when they were dispatched', () => {
    const state = withTasks(
      task({ id: 'late', startedAt: T0 + 100 }),
      task({ id: 'early', startedAt: T0 })
    )
    expect(workflowView(state, WORKFLOW)!.tasks.map((t) => t.callId)).toEqual([
      'early',
      'late',
    ])
  })

  it('returns nothing for a workflow it does not know', () => {
    expect(workflowView(emptyActivityState(), 'nope')).toBeNull()
  })
})

describe('per-session scoping', () => {
  const twoSessions = () => {
    let state = withTasks(task())
    state = startWorkflow(
      state,
      workflow({ id: 'run-2', sessionId: OTHER_SESSION, startedAt: T0 + 10 })
    )
    return startTask(
      state,
      task({ id: 'call-2', sessionId: OTHER_SESSION, workflowId: 'run-2' })
    )
  }

  it('shows a session only its own workflows', () => {
    const state = twoSessions()
    expect(sessionWorkflows(state, SESSION).map((v) => v.workflow.id)).toEqual([
      WORKFLOW,
    ])
    expect(
      sessionWorkflows(state, OTHER_SESSION).map((v) => v.workflow.id)
    ).toEqual(['run-2'])
  })

  it('counts only this session’s work in its totals', () => {
    expect(sessionTotals(twoSessions(), SESSION).total).toBe(1)
  })

  it('reports no workflows without a session', () => {
    expect(sessionWorkflows(twoSessions(), null)).toEqual([])
    expect(sessionIsActive(twoSessions(), null)).toBe(false)
  })

  it('lists a session’s workflows newest first', () => {
    let state = withTasks(task())
    state = startWorkflow(
      state,
      workflow({ id: 'run-3', startedAt: T0 + 500, title: 'later' })
    )
    expect(sessionWorkflows(state, SESSION).map((v) => v.workflow.id)).toEqual([
      'run-3',
      WORKFLOW,
    ])
  })

  it('forgets everything belonging to a deleted session', () => {
    const state = forgetSession(twoSessions(), SESSION)
    expect(Object.keys(state.workflows)).toEqual(['run-2'])
    expect(Object.values(state.tasks).map((t) => t.callId)).toEqual(['call-2'])
  })

  it('leaves the record alone when the session owns nothing', () => {
    const state = twoSessions()
    expect(forgetSession(state, 'never-existed')).toBe(state)
  })
})

describe('settling work a run left behind', () => {
  const shellJob = (over: Partial<ActivityTask> = {}) =>
    task({ kind: 'shell', title: 'pnpm build', status: 'running', ...over })

  it('cancels the run’s live work and says why', () => {
    const state = settleRunOrphans(
      withTasks(task({ status: 'running' })),
      WORKFLOW,
      T0 + 50,
      'interrupted:runEnd'
    )
    expect(state.tasks[idOf('call-1')]).toMatchObject({
      status: 'cancelled',
      endedAt: T0 + 50,
      detail: 'interrupted:runEnd',
    })
  })

  it('leaves a backgrounded shell job running', () => {
    // The tool call returned a job id and moved on; the process is still
    // running. Marking it cancelled would be false when written, and a
    // finished task's status is protected from later change, so no amount of
    // polling could repair it.
    const state = settleRunOrphans(
      withTasks(shellJob({ jobId: 'bash-3' })),
      WORKFLOW,
      T0 + 50,
      'interrupted:runEnd'
    )
    expect(state.tasks[idOf('call-1')].status).toBe('running')
  })

  it('settles a shell command that never got a job id', () => {
    // Still inside its tool call when the run died: the invoke carrying it is
    // gone, and nothing will ever report on it.
    const state = settleRunOrphans(
      withTasks(shellJob()),
      WORKFLOW,
      T0 + 50,
      'interrupted:runEnd'
    )
    expect(state.tasks[idOf('call-1')].status).toBe('cancelled')
  })

  it('leaves another run’s work alone', () => {
    // One turn ending says nothing about a second run in the same session.
    let state = withTasks(task({ status: 'running' }))
    state = startWorkflow(state, workflow({ id: 'run-2' }))
    state = startTask(
      state,
      task({ id: 'call-2', workflowId: 'run-2', status: 'running' })
    )
    const settled = settleRunOrphans(state, WORKFLOW, T0 + 50, 'runEnd')
    expect(settled.tasks[idOf('call-2', SESSION, 'run-2')].status).toBe(
      'running'
    )
  })

  it('leaves finished work exactly as it was', () => {
    const done = withTasks(task({ status: 'done', endedAt: T0 + 1 }))
    expect(settleRunOrphans(done, WORKFLOW, T0 + 50, 'runEnd')).toBe(done)
  })

  it('keeps a workflow running while its background command is', () => {
    // The model turn is over; the process is not, so neither is the workflow.
    const state = endWorkflow(
      settleRunOrphans(
        withTasks(shellJob({ jobId: 'bash-3' })),
        WORKFLOW,
        T0 + 50,
        'runEnd'
      ),
      WORKFLOW,
      T0 + 51
    )
    expect(sessionWorkflows(state, SESSION)[0].status).toBe('running')
  })

  it('knows which work outlives its run', () => {
    expect(survivesRunEnd(shellJob({ jobId: 'bash-3' }))).toBe(true)
    expect(survivesRunEnd(shellJob())).toBe(false)
    expect(survivesRunEnd(task({ status: 'running' }))).toBe(false)
  })
})

describe('settling on load', () => {
  it('settles every session, including background jobs', () => {
    // A restart kills the backend that held them; its shutdown reaps every
    // process tree it spawned. Nothing that was running is running now.
    let state = withTasks(
      task({ status: 'running' }),
      task({ id: 'job', kind: 'shell', status: 'running', jobId: 'bash-3' })
    )
    state = startWorkflow(
      state,
      workflow({ id: 'run-2', sessionId: OTHER_SESSION })
    )
    state = startTask(
      state,
      task({ id: 'call-2', sessionId: OTHER_SESSION, workflowId: 'run-2' })
    )
    const settled = settleOnLoad(state, T0 + 50, 'restart')
    // Interrupted, not cancelled: the app exiting stopped this, not a person.
    expect(settled.tasks[idOf('call-1')].status).toBe('interrupted')
    expect(settled.tasks[idOf('job')].status).toBe('interrupted')
    expect(
      settled.tasks[idOf('call-2', OTHER_SESSION, 'run-2')].status
    ).toBe('interrupted')
  })
})

describe('settling a whole session', () => {
  it('settles that session’s live work and no other', () => {
    let state = withTasks(task({ status: 'running' }))
    state = startWorkflow(
      state,
      workflow({ id: 'run-2', sessionId: OTHER_SESSION })
    )
    state = startTask(
      state,
      task({ id: 'call-2', sessionId: OTHER_SESSION, workflowId: 'run-2' })
    )
    const settled = settleSessionWork(state, SESSION, T0 + 50, 'cleared')
    expect(settled.tasks[idOf('call-1')].status).toBe('cancelled')
    expect(settled.tasks[idOf('call-2', OTHER_SESSION, 'run-2')].status).toBe(
      'running'
    )
  })
})

describe('clearing finished work', () => {
  it('hides a finished workflow but keeps the record', () => {
    const finished = endWorkflow(
      withTasks(task({ status: 'done', endedAt: T0 + 1 })),
      WORKFLOW,
      T0 + 2
    )
    const cleared = dismissFinished(finished, SESSION, T0 + 3)
    expect(sessionWorkflows(cleared, SESSION)).toEqual([])
    expect(
      sessionWorkflows(cleared, SESSION, { includeDismissed: true })
    ).toHaveLength(1)
  })

  it('leaves running work visible', () => {
    const state = withTasks(task({ status: 'running' }))
    expect(dismissFinished(state, SESSION, T0 + 3)).toBe(state)
    expect(sessionWorkflows(state, SESSION)).toHaveLength(1)
  })

  it('brings a dismissed workflow back if it is live again', () => {
    // Dismissal hides what is finished. Something that is running again is not.
    const finished = endWorkflow(
      withTasks(task({ status: 'done', endedAt: T0 + 1 })),
      WORKFLOW,
      T0 + 2
    )
    const cleared = dismissFinished(finished, SESSION, T0 + 3)
    const relive = updateTask(cleared, idOf('call-1'), { status: 'running' }, true)
    expect(sessionWorkflows(relive, SESSION)).toHaveLength(1)
  })

  it('clears only the session asked for', () => {
    let state = endWorkflow(
      withTasks(task({ status: 'done', endedAt: T0 + 1 })),
      WORKFLOW,
      T0 + 2
    )
    state = startWorkflow(
      state,
      workflow({ id: 'run-2', sessionId: OTHER_SESSION, endedAt: T0 + 2 })
    )
    const cleared = dismissFinished(state, OTHER_SESSION, T0 + 3)
    expect(cleared.workflows[WORKFLOW].dismissedAt).toBeUndefined()
  })
})

describe('the inline card’s anchor', () => {
  it('finds the workflow anchored at a message', () => {
    const state = startWorkflow(
      emptyActivityState(),
      workflow({ anchorMessageId: 'msg-7' })
    )
    expect(workflowAnchoredAt(state, SESSION, 'msg-7')?.workflow.id).toBe(
      WORKFLOW
    )
  })

  it('finds nothing at a message that anchors no workflow', () => {
    const state = startWorkflow(
      emptyActivityState(),
      workflow({ anchorMessageId: 'msg-7' })
    )
    expect(workflowAnchoredAt(state, SESSION, 'msg-8')).toBeNull()
  })

  it('does not match another session’s anchor', () => {
    // Message ids are per-session; a collision must not show one session's
    // card inside another.
    const state = startWorkflow(
      emptyActivityState(),
      workflow({ anchorMessageId: 'msg-7' })
    )
    expect(workflowAnchoredAt(state, OTHER_SESSION, 'msg-7')).toBeNull()
  })
})

describe('small helpers', () => {
  it('measures a finished task to its end and a running one to now', () => {
    expect(taskElapsedMs(task({ endedAt: T0 + 250 }), T0 + 9999)).toBe(250)
    expect(taskElapsedMs(task(), T0 + 250)).toBe(250)
  })

  it('never reports a negative duration when the clock moves back', () => {
    expect(taskElapsedMs(task({ startedAt: T0 }), T0 - 5000)).toBe(0)
  })

  it('offers to cancel only what is still going', () => {
    expect(isCancellable(task({ status: 'running' }))).toBe(true)
    expect(isCancellable(task({ status: 'queued' }))).toBe(true)
    expect(isCancellable(task({ status: 'done' }))).toBe(false)
    expect(isCancellable(task({ status: 'cancelled' }))).toBe(false)
  })
})

describe('reading the phase work is dispatched under', () => {
  const list = (...phases: { name: string; statuses: string[] }[]) => ({
    phases: phases.map((phase) => ({
      name: phase.name,
      tasks: phase.statuses.map((status) => ({
        content: 'x',
        status: status as 'pending' | 'in_progress' | 'completed' | 'abandoned',
      })),
    })),
  })

  it('is the phase with work in progress', () => {
    expect(
      currentPhase(
        list(
          { name: 'Scan', statuses: ['completed'] },
          { name: 'Fix', statuses: ['in_progress', 'pending'] }
        )
      )
    ).toEqual({ name: 'Fix', index: 1 })
  })

  it('is the first such phase when several are in progress', () => {
    expect(
      currentPhase(
        list(
          { name: 'Scan', statuses: ['in_progress'] },
          { name: 'Fix', statuses: ['in_progress'] }
        )
      )
    ).toEqual({ name: 'Scan', index: 0 })
  })

  it('is nothing when the agent has marked no phase in progress', () => {
    // Recorded unphased rather than filed under a guess.
    expect(
      currentPhase(list({ name: 'Scan', statuses: ['pending', 'completed'] }))
    ).toBeUndefined()
  })

  it('is nothing without a list at all', () => {
    expect(currentPhase(undefined)).toBeUndefined()
    expect(currentPhase(null)).toBeUndefined()
    expect(currentPhase({ phases: [] })).toBeUndefined()
  })
})

describe('matching a backend job id to its task', () => {
  const shellJob = (over: Partial<ActivityTask> = {}) =>
    task({ kind: 'shell', title: 'pnpm build', status: 'running', ...over })

  it('finds the live task holding the job', () => {
    const state = withTasks(shellJob({ id: 'a', jobId: 'bash-0' }))
    expect(findTaskByJob(state, 'bash-0')?.callId).toBe('a')
  })

  it('still matches a killed task, whose output is what a collection is for', () => {
    const state = withTasks(
      shellJob({ id: 'killed', jobId: 'bash-0', status: 'cancelled' })
    )
    expect(findTaskByJob(state, 'bash-0')?.callId).toBe('killed')
  })

  it('prefers live work over a settled claim on the same id', () => {
    const state = withTasks(
      shellJob({ id: 'settled', jobId: 'bash-0', status: 'cancelled' }),
      shellJob({ id: 'live', jobId: 'bash-0', status: 'running' })
    )
    expect(findTaskByJob(state, 'bash-0')?.callId).toBe('live')
  })

  it('prefers the newest live claim on a reused id', () => {
    const state = withTasks(
      shellJob({ id: 'old', jobId: 'bash-0', startedAt: T0 }),
      shellJob({ id: 'new', jobId: 'bash-0', startedAt: T0 + 1000 })
    )
    expect(findTaskByJob(state, 'bash-0')?.callId).toBe('new')
  })

  it('drops every job id when the app restarts', () => {
    // The backend that minted them died with the app, and its counter starts
    // again at zero; keeping the id would let unrelated work claim this row.
    const settled = settleOnLoad(
      withTasks(shellJob({ id: 'a', jobId: 'bash-0' })),
      T0 + 50,
      'restart'
    )
    expect(settled.tasks[idOf('a')].jobId).toBeUndefined()
    expect(settled.tasks[idOf('a')].status).toBe('interrupted')
    expect(findTaskByJob(settled, 'bash-0')).toBeUndefined()
  })
})

describe('phase identity when the todo list is re-indexed', () => {
  it('does not reuse a phase id for a different phase at the same position', () => {
    // `todo rm` filters a phase out, shifting every later one down. Position
    // alone would file the new phase's work under the removed phase's heading.
    const state = startWorkflow(emptyActivityState(), workflow())
    const research = observePhase(state, WORKFLOW, {
      name: 'Research',
      index: 0,
    })
    const implement = observePhase(research.state, WORKFLOW, {
      name: 'Implement',
      index: 0,
    })
    expect(implement.phaseId).not.toBe(research.phaseId)
    expect(
      implement.state.workflows[WORKFLOW].phases.map((p) => p.name)
    ).toEqual(['Research', 'Implement'])
  })

  it('still reuses the id for the same phase at the same position', () => {
    const state = startWorkflow(emptyActivityState(), workflow())
    const first = observePhase(state, WORKFLOW, { name: 'Research', index: 0 })
    const again = observePhase(first.state, WORKFLOW, {
      name: 'Research',
      index: 0,
    })
    expect(again.phaseId).toBe(first.phaseId)
    expect(again.state).toBe(first.state)
  })
})
