/**
 * The canonical model of Cowork background activity.
 *
 * Everything that reports on background work — the Background Tasks panel, the
 * inline workflow card in the conversation, the activity chip — reads this one
 * model. Keeping a second copy anywhere is what makes two surfaces disagree
 * about the same run, so there is exactly one.
 *
 * Pure and store-free, like `coworkCode.ts`: the reducers and the progress
 * arithmetic are testable without React or zustand.
 *
 * ## What is real here
 *
 * Every field is recorded at the moment the thing it describes happens, from
 * data the run already has. Nothing is inferred from a name, guessed from
 * elapsed time, or filled in to make a display look complete:
 *
 * - a **task** is one unit of background work — a subagent the `task` tool
 *   dispatched, or a shell command the `bash` tool ran. Its id is the tool call
 *   id that started it, so it is stable across a reload and cannot collide with
 *   another call.
 * - a **phase** is a stage of the parent's own todo list, captured when a task
 *   is dispatched under it. Phases are recorded as they are first observed and
 *   never rewritten, so a later `todo_write` cannot retroactively move work
 *   that has already run.
 * - a **workflow** is one agent run that dispatched background work. It is
 *   created by the first dispatch rather than by the run starting, because a
 *   run that never dispatched anything has no background activity to report.
 *
 * Status is derived from real child state (see `workflowStatus`), never stored
 * on the parent, so a parent can never claim to be finished while a child is
 * still running.
 */

import type { CoworkTurn, TodoList, Usage } from '@/types/coworkSession'

export type ActivityStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled'

export type ActivityKind = 'agent' | 'shell'

/** A stage of the parent's todo list, as it stood when work was dispatched. */
export type ActivityPhase = {
  /** Stable for the life of the workflow. Never reused, never renumbered. */
  id: string
  /** The phase name at the moment it was first observed. */
  name: string
  /** Its position in the todo list then, for ordering. */
  index: number
}

/** One unit of background work. */
export type ActivityTask = {
  /** The tool call id that started this work. Stable across reloads. */
  id: string
  sessionId: string
  workflowId: string
  /** The phase in progress when this was dispatched, when there was one. */
  phaseId?: string
  /** The task that dispatched this one, when it was nested. */
  parentTaskId?: string
  kind: ActivityKind
  /** The subagent's name, or the command line. */
  title: string
  status: ActivityStatus
  startedAt: number
  endedAt?: number
  /** 1-based queue position while `queued`. */
  waiting?: number

  // --- Dispatch-time metadata. Captured once, from what the run actually
  // used; absent rather than guessed when the run did not record it. ---

  /** The model id this work ran on. */
  model?: string
  /** The subagent definition's name. */
  agentName?: string
  /** The description the parent gave when dispatching. */
  description?: string
  /** The command line, for shell work. */
  command?: string
  /** The backend job id, once a command has been backgrounded. */
  jobId?: string

  // --- Outcome, recorded as it lands. ---

  usage?: Usage
  toolCount?: number
  /** The subagent's own trace. */
  transcript?: CoworkTurn[]
  /** The final answer, or the command's output. */
  output?: string
  /** Why this stopped, when it was cancelled or failed. */
  detail?: string
}

/** One agent run that dispatched background work. */
export type ActivityWorkflow = {
  id: string
  sessionId: string
  /** What the user asked for on the turn that started this run. */
  title: string
  startedAt: number
  endedAt?: number
  /** Phases in the order they were first observed. */
  phases: ActivityPhase[]
  /** The assistant message the inline card anchors to. */
  anchorMessageId?: string
  /** The model the parent run used. */
  model?: string
  /** Hidden from the live lists by "clear finished", but kept as a record. */
  dismissedAt?: number
}

export type ActivityState = {
  workflows: Record<string, ActivityWorkflow>
  tasks: Record<string, ActivityTask>
}

export const emptyActivityState = (): ActivityState => ({
  workflows: {},
  tasks: {},
})

const FINISHED: ReadonlySet<ActivityStatus> = new Set<ActivityStatus>([
  'done',
  'error',
  'cancelled',
])

export const isFinished = (status: ActivityStatus): boolean =>
  FINISHED.has(status)

export const isLive = (status: ActivityStatus): boolean => !FINISHED.has(status)

/** A phase id that is stable for the life of its workflow. */
export const phaseIdFor = (workflowId: string, ordinal: number): string =>
  `${workflowId}:p${ordinal}`

// --- Reducers -------------------------------------------------------------
//
// Each returns a new state, or the same reference when nothing changed, so a
// store can skip a render on a no-op event.

/** Record a run that has just dispatched its first background work. */
export function startWorkflow(
  state: ActivityState,
  workflow: ActivityWorkflow
): ActivityState {
  if (state.workflows[workflow.id]) return state
  return {
    ...state,
    workflows: { ...state.workflows, [workflow.id]: workflow },
  }
}

/**
 * Note the phase a dispatch happened under, returning its stable id.
 *
 * A phase already recorded keeps the name it was recorded with: the todo list
 * is rewritten wholesale by `todo_write`, and rewriting history to match the
 * latest list would move work that has already run.
 */
export function observePhase(
  state: ActivityState,
  workflowId: string,
  phase: { name: string; index: number }
): { state: ActivityState; phaseId: string | undefined } {
  const workflow = state.workflows[workflowId]
  if (!workflow) return { state, phaseId: undefined }
  const existing = workflow.phases.find((p) => p.index === phase.index)
  if (existing) return { state, phaseId: existing.id }
  const recorded: ActivityPhase = {
    id: phaseIdFor(workflowId, workflow.phases.length),
    name: phase.name,
    index: phase.index,
  }
  return {
    state: {
      ...state,
      workflows: {
        ...state.workflows,
        [workflowId]: { ...workflow, phases: [...workflow.phases, recorded] },
      },
    },
    phaseId: recorded.id,
  }
}

/** Record a dispatched unit of work. Re-dispatch of the same id is ignored. */
export function startTask(
  state: ActivityState,
  task: ActivityTask
): ActivityState {
  if (state.tasks[task.id]) return state
  return { ...state, tasks: { ...state.tasks, [task.id]: task } }
}

/**
 * Merge an update onto a task.
 *
 * A task that has already finished keeps its status: a late event from a
 * stream that was torn down must not resurrect a cancelled task or overwrite
 * the reason it stopped. Outcome fields still land, because a killed job's
 * remaining output is worth having. `force` is for the caller that genuinely
 * re-opens a task.
 */
export function updateTask(
  state: ActivityState,
  id: string,
  patch: Partial<ActivityTask>,
  force = false
): ActivityState {
  const task = state.tasks[id]
  if (!task) return state
  if (!force && isFinished(task.status) && patch.status !== task.status) {
    const { status: _status, endedAt: _endedAt, ...rest } = patch
    if (Object.keys(rest).length === 0) return state
    return { ...state, tasks: { ...state.tasks, [id]: { ...task, ...rest } } }
  }
  return { ...state, tasks: { ...state.tasks, [id]: { ...task, ...patch } } }
}

/** Close a workflow once its run is over. */
export function endWorkflow(
  state: ActivityState,
  id: string,
  endedAt: number
): ActivityState {
  const workflow = state.workflows[id]
  if (!workflow || workflow.endedAt != null) return state
  return {
    ...state,
    workflows: { ...state.workflows, [id]: { ...workflow, endedAt } },
  }
}

/**
 * Settle everything a torn-down run left running.
 *
 * Called when a run ends for any reason, and on load. Without it a task whose
 * end event never arrived — the app was closed, the stream failed — would spin
 * forever in the panel across every future session.
 */
export function settleOrphans(
  state: ActivityState,
  sessionId: string | null,
  now: number,
  reason: string
): ActivityState {
  let tasks = state.tasks
  let changed = false
  for (const task of Object.values(state.tasks)) {
    if (sessionId != null && task.sessionId !== sessionId) continue
    if (isFinished(task.status)) continue
    if (!changed) {
      tasks = { ...tasks }
      changed = true
    }
    tasks[task.id] = {
      ...task,
      status: 'cancelled',
      endedAt: now,
      detail: reason,
    }
  }
  return changed ? { ...state, tasks } : state
}

/** Hide every finished workflow of a session, keeping the records. */
export function dismissFinished(
  state: ActivityState,
  sessionId: string,
  now: number
): ActivityState {
  const byWorkflow = tasksByWorkflow(state)
  let workflows = state.workflows
  let changed = false
  for (const workflow of Object.values(state.workflows)) {
    if (workflow.sessionId !== sessionId || workflow.dismissedAt != null) {
      continue
    }
    if (isLive(workflowStatus(workflow, byWorkflow.get(workflow.id) ?? []))) {
      continue
    }
    if (!changed) {
      workflows = { ...workflows }
      changed = true
    }
    workflows[workflow.id] = { ...workflow, dismissedAt: now }
  }
  return changed ? { ...state, workflows } : state
}

/** Forget everything belonging to a session that no longer exists. */
export function forgetSession(
  state: ActivityState,
  sessionId: string
): ActivityState {
  const workflows = Object.fromEntries(
    Object.entries(state.workflows).filter(([, w]) => w.sessionId !== sessionId)
  )
  const tasks = Object.fromEntries(
    Object.entries(state.tasks).filter(([, t]) => t.sessionId !== sessionId)
  )
  if (
    Object.keys(workflows).length === Object.keys(state.workflows).length &&
    Object.keys(tasks).length === Object.keys(state.tasks).length
  ) {
    return state
  }
  return { workflows, tasks }
}

// --- Selectors ------------------------------------------------------------

/** Every task, grouped by the workflow that owns it, in dispatch order. */
export function tasksByWorkflow(
  state: ActivityState
): Map<string, ActivityTask[]> {
  const byWorkflow = new Map<string, ActivityTask[]>()
  for (const task of Object.values(state.tasks)) {
    const list = byWorkflow.get(task.workflowId)
    if (list) list.push(task)
    else byWorkflow.set(task.workflowId, [task])
  }
  for (const list of byWorkflow.values()) {
    list.sort((a, b) => a.startedAt - b.startedAt)
  }
  return byWorkflow
}

export function tasksOfWorkflow(
  state: ActivityState,
  workflowId: string
): ActivityTask[] {
  return Object.values(state.tasks)
    .filter((task) => task.workflowId === workflowId)
    .sort((a, b) => a.startedAt - b.startedAt)
}

export function tasksOfPhase(
  tasks: ActivityTask[],
  phaseId: string
): ActivityTask[] {
  return tasks.filter((task) => task.phaseId === phaseId)
}

/** Work dispatched by a task, for the nested view. */
export function childrenOf(
  tasks: ActivityTask[],
  parentTaskId: string
): ActivityTask[] {
  return tasks.filter((task) => task.parentTaskId === parentTaskId)
}

/** Top-level work: dispatched by the run itself, not by another task. */
export function rootTasks(tasks: ActivityTask[]): ActivityTask[] {
  return tasks.filter((task) => !task.parentTaskId)
}

export type ActivityProgress = {
  total: number
  running: number
  queued: number
  done: number
  error: number
  cancelled: number
  finished: number
  /** 0–1, or `null` with nothing to measure. Counts finished work of any kind:
   * a failed task is over, and a bar that never fills is not progress. */
  fraction: number | null
  tokens: number
  toolCalls: number
}

export function progressOf(tasks: ActivityTask[]): ActivityProgress {
  const count = (status: ActivityStatus) =>
    tasks.filter((task) => task.status === status).length
  const done = count('done')
  const error = count('error')
  const cancelled = count('cancelled')
  const finished = done + error + cancelled
  return {
    total: tasks.length,
    running: count('running'),
    queued: count('queued'),
    done,
    error,
    cancelled,
    finished,
    fraction: tasks.length === 0 ? null : finished / tasks.length,
    tokens: tasks.reduce((sum, task) => sum + (task.usage?.total_tokens ?? 0), 0),
    toolCalls: tasks.reduce((sum, task) => sum + (task.toolCount ?? 0), 0),
  }
}

/**
 * A workflow's status, derived from its children rather than stored.
 *
 * Anything still live makes the workflow live, so it can never report itself
 * finished while a child is still running. Among finished children, a failure
 * outranks a cancellation, which outranks success: the most serious real
 * outcome is the one worth surfacing.
 */
export function workflowStatus(
  workflow: ActivityWorkflow,
  tasks: ActivityTask[]
): ActivityStatus {
  if (tasks.some((task) => task.status === 'running')) return 'running'
  if (tasks.some((task) => task.status === 'queued')) {
    // A run that is over cannot still have work waiting for a slot; that is a
    // torn-down queue, not a live one.
    return workflow.endedAt == null ? 'queued' : 'cancelled'
  }
  if (tasks.some((task) => task.status === 'error')) return 'error'
  if (tasks.length > 0 && tasks.every((task) => task.status === 'cancelled')) {
    return 'cancelled'
  }
  // No children yet and the run is still going: the dispatch that created this
  // workflow is itself the work in flight.
  if (workflow.endedAt == null && tasks.length === 0) return 'running'
  return 'done'
}

/** A workflow with everything a surface needs to render it. */
export type WorkflowView = {
  workflow: ActivityWorkflow
  tasks: ActivityTask[]
  status: ActivityStatus
  progress: ActivityProgress
  phases: { phase: ActivityPhase; tasks: ActivityTask[] }[]
  /** Work dispatched outside any phase. */
  unphased: ActivityTask[]
}

export function workflowView(
  state: ActivityState,
  workflowId: string
): WorkflowView | null {
  const workflow = state.workflows[workflowId]
  if (!workflow) return null
  const tasks = tasksOfWorkflow(state, workflowId)
  return {
    workflow,
    tasks,
    status: workflowStatus(workflow, tasks),
    progress: progressOf(tasks),
    phases: workflow.phases
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((phase) => ({ phase, tasks: tasksOfPhase(tasks, phase.id) })),
    unphased: tasks.filter((task) => !task.phaseId),
  }
}

/**
 * A session's workflows, newest first.
 *
 * Dismissed workflows are excluded unless they are live again — "clear
 * finished" hides a record, and a record that has since resumed is not
 * finished.
 */
export function sessionWorkflows(
  state: ActivityState,
  sessionId: string | null | undefined,
  opts: { includeDismissed?: boolean } = {}
): WorkflowView[] {
  if (!sessionId) return []
  return Object.values(state.workflows)
    .filter((workflow) => workflow.sessionId === sessionId)
    .map((workflow) => workflowView(state, workflow.id))
    .filter((view): view is WorkflowView => view !== null)
    .filter(
      (view) =>
        opts.includeDismissed ||
        view.workflow.dismissedAt == null ||
        isLive(view.status)
    )
    .sort((a, b) => b.workflow.startedAt - a.workflow.startedAt)
}

/** The totals the activity chip shows for a session. */
export function sessionTotals(
  state: ActivityState,
  sessionId: string | null | undefined
): ActivityProgress {
  return progressOf(
    sessionWorkflows(state, sessionId).flatMap((view) => view.tasks)
  )
}

/** Whether anything in this session is still going. */
export function sessionIsActive(
  state: ActivityState,
  sessionId: string | null | undefined
): boolean {
  const totals = sessionTotals(state, sessionId)
  return totals.running + totals.queued > 0
}

/**
 * Which workflow a message anchors, if any.
 *
 * Exactly one card per workflow: the anchor is recorded once, on the message
 * the first dispatch landed under, and never moved.
 */
export function workflowAnchoredAt(
  state: ActivityState,
  sessionId: string | null | undefined,
  messageId: string
): WorkflowView | null {
  if (!sessionId) return null
  const workflow = Object.values(state.workflows).find(
    (w) => w.sessionId === sessionId && w.anchorMessageId === messageId
  )
  return workflow ? workflowView(state, workflow.id) : null
}

/**
 * The todo phase the agent says it is working in, if any.
 *
 * Read at dispatch time and then recorded, never matched afterwards: the list
 * is rewritten wholesale by `todo_write`, so the only moment this is reliably
 * true of a given task is the moment that task starts. A list with nothing
 * marked in progress gives no phase, and the work is recorded unphased rather
 * than being filed under a guess.
 */
export function currentPhase(
  todos: TodoList | undefined | null
): { name: string; index: number } | undefined {
  const phases = todos?.phases ?? []
  for (let index = 0; index < phases.length; index++) {
    if (phases[index].tasks.some((item) => item.status === 'in_progress')) {
      return { name: phases[index].name, index }
    }
  }
  return undefined
}

/** Recorded on work a turn's own end left unfinished. */
export const INTERRUPTED_BY_RUN_END = 'interrupted:runEnd'

/** Elapsed ms for a task: to its end, or to `now` while it is still going. */
export function taskElapsedMs(task: ActivityTask, now: number): number {
  // Clamped: a clock adjustment mid-run must not render a negative duration.
  return Math.max(0, (task.endedAt ?? now) - task.startedAt)
}

/** Can this task actually be cancelled, or is there nothing left to stop? */
export function isCancellable(task: ActivityTask): boolean {
  return isLive(task.status)
}
