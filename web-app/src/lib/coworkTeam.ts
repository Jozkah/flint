/**
 * Coordinating several subagents on one piece of work.
 *
 * Subagents already run: bounded to three at a time, each with its own
 * transcript lane, each with its requested tools intersected against the
 * parent's rather than unioned. What they cannot do is work on the *same*
 * thing — there is no shared list of what needs doing, no way to say one task
 * waits on another, and nothing that notices two children about to change the
 * same file.
 *
 * This is that layer, and it is deliberately pure: a task graph, an ordering,
 * a conflict check and a report assembler, none of which touch a model, a
 * store or the filesystem. Coordination bugs are hard to see in a live run and
 * trivial to see in a table, so the decisions live where they can be tabulated.
 *
 * One rule outranks the rest. **A child's failure is never a fabricated success
 * in the parent's summary.** The report is assembled from recorded results, and
 * there is no path here that turns a missing result into an assumed one — which
 * is why [`assembleReport`] takes results rather than prose about them.
 */

/** What a child was asked to do. */
export type TeamTask = {
  id: string
  /** What to do, stated so a child that sees none of this conversation can act. */
  description: string
  /**
   * Which saved subagent runs it, when the caller named one.
   *
   * Absent means the run's default child. Resolution stays where it already
   * is — a team does not get its own way of choosing an agent, or the tool
   * intersection that resolution performs would have two implementations.
   */
  subagentName?: string
  /** Ids that must be `completed` before this may start. */
  dependsOn: string[]
  /**
   * Paths this task expects to change, relative to the run's write root.
   *
   * Declared rather than discovered, so a conflict is caught before two
   * children have both done the work. An empty list means the task changes
   * nothing, which never conflicts with anything.
   */
  writes: string[]
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  /** A dependency failed, so this can never become runnable. */
  | 'blocked'
  | 'cancelled'

export type TaskState = {
  status: TaskStatus
  /** Which child holds it, while one does. */
  owner?: string
}

export type TeamState = Record<string, TaskState>

/** The starting state: everything pending, nothing owned. */
export function initialState(tasks: readonly TeamTask[]): TeamState {
  const state: TeamState = {}
  for (const task of tasks) state[task.id] = { status: 'pending' }
  return state
}

/**
 * Ids named as dependencies that no task provides.
 *
 * A dangling dependency would otherwise make a task permanently unrunnable and
 * look like a scheduling stall, which is a much harder thing to diagnose than
 * a list of names nobody defined.
 */
export function danglingDependencies(tasks: readonly TeamTask[]): string[] {
  const known = new Set(tasks.map((task) => task.id))
  const missing = new Set<string>()
  for (const task of tasks) {
    for (const dep of task.dependsOn) if (!known.has(dep)) missing.add(dep)
  }
  return [...missing].sort()
}

/**
 * A dependency cycle, as the ids involved, or null when there is none.
 *
 * Reported rather than tolerated: a cycle means nothing in it can ever start,
 * and a scheduler that simply returns "nothing is ready" forever gives no clue
 * why.
 */
export function findCycle(tasks: readonly TeamTask[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set<string>()
  const done = new Set<string>()
  const stack: string[] = []

  const walk = (id: string): string[] | null => {
    if (done.has(id)) return null
    if (visiting.has(id)) {
      // The cycle is the stack from where this id first appears.
      const from = stack.indexOf(id)
      return stack.slice(from).concat(id)
    }
    visiting.add(id)
    stack.push(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const found = walk(dep)
      if (found) return found
    }
    stack.pop()
    visiting.delete(id)
    done.add(id)
    return null
  }

  // Sorted so the reported cycle is the same one every run, which matters when
  // the message ends up in a bug report.
  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    const found = walk(task.id)
    if (found) return found
  }
  return null
}

/**
 * Tasks that could start now.
 *
 * Ordered by id so the same graph dispatches in the same order every time.
 * Deterministic dispatch is what makes a coordination failure reproducible
 * rather than a thing that happened once on someone's machine.
 */
export function readyTasks(
  tasks: readonly TeamTask[],
  state: TeamState
): TeamTask[] {
  return [...tasks]
    .filter((task) => (state[task.id]?.status ?? 'pending') === 'pending')
    .filter((task) =>
      task.dependsOn.every((dep) => state[dep]?.status === 'completed')
    )
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Record an outcome, and propagate it.
 *
 * A failure blocks everything downstream in the same pass. Leaving dependents
 * `pending` would have them sit there looking schedulable while their
 * precondition is permanently gone, and a run that ends with tasks still
 * "pending" reads as interrupted rather than as failed.
 */
export function settle(
  tasks: readonly TeamTask[],
  state: TeamState,
  id: string,
  status: Extract<TaskStatus, 'completed' | 'failed' | 'cancelled'>
): TeamState {
  const next: TeamState = { ...state, [id]: { status } }
  if (status === 'completed') return next

  // Transitively: a dependent of a blocked task is itself unreachable.
  let changed = true
  while (changed) {
    changed = false
    for (const task of tasks) {
      const current = next[task.id]?.status ?? 'pending'
      if (current !== 'pending') continue
      const stuck = task.dependsOn.some((dep) => {
        const depStatus = next[dep]?.status
        return (
          depStatus === 'failed' ||
          depStatus === 'blocked' ||
          depStatus === 'cancelled'
        )
      })
      if (stuck) {
        next[task.id] = { status: 'blocked' }
        changed = true
      }
    }
  }
  return next
}

/** Two tasks that intend to change the same path. */
export type Conflict = {
  path: string
  /** The task ids that both declared it, sorted. */
  tasks: string[]
}

/**
 * Conflicts among tasks that could run at the same time.
 *
 * Only among tasks with no ordering between them: two tasks that both touch a
 * file are perfectly fine when one waits for the other, and reporting that as a
 * conflict would make the dependency mechanism useless. So a conflict is
 * exactly a shared write target with no path between the two tasks.
 */
export function conflicts(tasks: readonly TeamTask[]): Conflict[] {
  const related = reachability(tasks)
  const byPath = new Map<string, string[]>()
  for (const task of tasks) {
    for (const path of task.writes) {
      byPath.set(path, [...(byPath.get(path) ?? []), task.id])
    }
  }

  const found: Conflict[] = []
  for (const [path, ids] of byPath) {
    const clashing = new Set<string>()
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const [a, b] = [ids[i], ids[j]]
        if (!related.get(a)?.has(b) && !related.get(b)?.has(a)) {
          clashing.add(a)
          clashing.add(b)
        }
      }
    }
    if (clashing.size > 0) {
      found.push({ path, tasks: [...clashing].sort() })
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

/** For each task, every task it transitively depends on. */
function reachability(tasks: readonly TeamTask[]): Map<string, Set<string>> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const cache = new Map<string, Set<string>>()

  const walk = (id: string, seen: Set<string>): Set<string> => {
    const cached = cache.get(id)
    if (cached) return cached
    if (seen.has(id)) return new Set()
    seen.add(id)
    const out = new Set<string>()
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      out.add(dep)
      for (const deeper of walk(dep, seen)) out.add(deeper)
    }
    cache.set(id, out)
    return out
  }

  const result = new Map<string, Set<string>>()
  for (const task of tasks) result.set(task.id, walk(task.id, new Set()))
  return result
}

/** What a child actually came back with. */
export type TaskResult = {
  taskId: string
  ok: boolean
  /** The child's own answer, or the reason it failed. */
  output: string
  /** Where the claim comes from: the child that produced it. */
  producedBy: string
}

export type TeamReport = {
  completed: TaskResult[]
  failed: TaskResult[]
  /** Ids with no result: blocked, cancelled, or never dispatched. */
  unfinished: string[]
  /** True only when every task completed. */
  allDone: boolean
}

/**
 * Assemble the parent's report from what the children returned.
 *
 * Takes results, not a summary of them, because that is the whole safeguard: a
 * task with no recorded result is `unfinished`, never assumed done. `allDone`
 * is computed from the task list rather than from the results, so a task that
 * was never dispatched at all cannot go unnoticed.
 *
 * Every list is sorted by task id, so the same run produces the same report.
 */
export function assembleReport(
  tasks: readonly TeamTask[],
  results: readonly TaskResult[]
): TeamReport {
  const byId = new Map(results.map((result) => [result.taskId, result]))
  const completed: TaskResult[] = []
  const failed: TaskResult[] = []
  const unfinished: string[] = []

  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    const result = byId.get(task.id)
    if (!result) {
      unfinished.push(task.id)
      continue
    }
    if (result.ok) completed.push(result)
    else failed.push(result)
  }

  return {
    completed,
    failed,
    unfinished,
    allDone: completed.length === tasks.length,
  }
}

// ---------------------------------------------------------------------------
// Running the graph

/** The name a model calls to dispatch a team. */
export const TEAM_TOOL_NAME = 'team'

/** How many children a team runs at once, matching the subagent gate. */
export const MAX_TEAM_PARALLEL = 3

/** Tasks in one team. Enough to be worth coordinating, few enough to follow. */
export const MAX_TEAM_TASKS = 12

/**
 * Read a team request from what the model emitted.
 *
 * Returns the tasks, or a sentence saying what is wrong with them. A string
 * rather than a thrown error because it goes back to the model as a tool
 * result: it has to be able to read the problem and try again.
 */
export function parseTeamRequest(raw: unknown): TeamTask[] | string {
  if (!raw || typeof raw !== 'object') return 'team needs a `tasks` array'
  const input = raw as Record<string, unknown>
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    return 'team needs a non-empty `tasks` array'
  }
  if (input.tasks.length > MAX_TEAM_TASKS) {
    return `a team is at most ${MAX_TEAM_TASKS} tasks; split the work`
  }

  const tasks: TeamTask[] = []
  const seen = new Set<string>()
  for (const entry of input.tasks) {
    if (!entry || typeof entry !== 'object') return 'each task must be an object'
    const one = entry as Record<string, unknown>
    const id = typeof one.id === 'string' ? one.id.trim() : ''
    const description =
      typeof one.description === 'string' ? one.description.trim() : ''
    if (!id) return 'each task needs an `id`'
    if (!description) {
      // A child sees none of this conversation, so an empty brief is a
      // guaranteed-useless run rather than a recoverable one.
      return `task '${id}' needs a description the child can act on alone`
    }
    if (seen.has(id)) return `task id '${id}' appears twice`
    seen.add(id)
    const subagentName =
      typeof one.subagent_name === 'string' && one.subagent_name.trim()
        ? one.subagent_name.trim()
        : undefined
    tasks.push({
      id,
      description,
      ...(subagentName ? { subagentName } : {}),
      dependsOn: stringList(one.depends_on),
      writes: stringList(one.writes),
    })
  }
  return tasks
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((one): one is string => typeof one === 'string' && one !== '')
    : []

/**
 * Why a graph was refused, phrased for the model that sent it.
 *
 * Checked before anything runs. Every one of these means the graph cannot
 * finish, and starting it anyway would burn children on work that is already
 * known to be unreachable.
 */
export function refuseGraph(tasks: readonly TeamTask[]): string | null {
  const missing = danglingDependencies(tasks)
  if (missing.length > 0) {
    return `these tasks are waiting on ids that no task provides: ${missing.join(', ')}`
  }
  const cycle = findCycle(tasks)
  if (cycle) {
    return `these tasks depend on each other in a loop: ${cycle.join(' -> ')}`
  }
  const clashes = conflicts(tasks)
  if (clashes.length > 0) {
    const described = clashes
      .map((one) => `${one.path} (${one.tasks.join(', ')})`)
      .join('; ')
    return (
      `these tasks would change the same files with nothing ordering them: ${described}. ` +
      'Add a `depends_on` so one runs after the other, or give them separate files.'
    )
  }
  return null
}

export type TeamRunDeps = {
  /** Runs one task as a child. The only thing here that touches a model. */
  runTask: (task: TeamTask, signal: AbortSignal) => Promise<TaskResult>
  /** Stops the whole team. Children get a signal chained to it. */
  signal?: AbortSignal
  maxParallel?: number
  /** Called whenever a task changes state, for the Tasks panel. */
  onState?: (state: TeamState) => void
}

export type TeamOutcome =
  /** The graph could not run at all; nothing was dispatched. */
  | { ok: false; refusal: string }
  | { ok: true; report: TeamReport; state: TeamState }

/**
 * Run a task graph to completion, or to the first thing that stops it.
 *
 * Dispatches ready tasks up to `maxParallel`, waits for the first to settle,
 * and looks again — so a task becomes runnable the moment its last dependency
 * finishes rather than at the end of a batch. A failure blocks its dependents
 * through [`settle`] and the loop simply finds fewer ready tasks next time.
 *
 * Cancellation stops dispatch immediately. Children already running are
 * cancelled through their own signal and settle as `cancelled`; tasks never
 * dispatched stay unfinished, because that is what they are — reporting them
 * as cancelled would claim a decision nobody made about them.
 */
export async function runTeam(
  tasks: readonly TeamTask[],
  deps: TeamRunDeps
): Promise<TeamOutcome> {
  const refusal = refuseGraph(tasks)
  if (refusal) return { ok: false, refusal }

  const limit = Math.max(1, deps.maxParallel ?? MAX_TEAM_PARALLEL)
  let state = initialState(tasks)
  const results: TaskResult[] = []
  const running = new Map<string, Promise<void>>()

  const publish = () => deps.onState?.(state)
  publish()

  const start = (task: TeamTask) => {
    state = { ...state, [task.id]: { status: 'running' } }
    const child = new AbortController()
    // Chained rather than shared: stopping the team stops every child, and a
    // child can still be stopped on its own without touching the others.
    const stop = () => child.abort('cancelled')
    if (deps.signal) {
      if (deps.signal.aborted) child.abort('cancelled')
      else deps.signal.addEventListener('abort', stop, { once: true })
    }

    const work = deps
      .runTask(task, child.signal)
      .then(
        (result) => {
          results.push(result)
          state = settle(tasks, state, task.id, result.ok ? 'completed' : 'failed')
        },
        (error: unknown) => {
          // A child that threw is a failed task, not a crashed team: the point
          // of running several is that one going wrong does not take the rest.
          const message = error instanceof Error ? error.message : String(error)
          const cancelled = child.signal.aborted
          results.push({
            taskId: task.id,
            ok: false,
            output: cancelled ? 'cancelled' : message,
            producedBy: task.id,
          })
          state = settle(tasks, state, task.id, cancelled ? 'cancelled' : 'failed')
        }
      )
      .finally(() => {
        deps.signal?.removeEventListener('abort', stop)
        running.delete(task.id)
        publish()
      })

    running.set(task.id, work)
  }

  while (!deps.signal?.aborted) {
    for (const task of readyTasks(tasks, state)) {
      if (running.size >= limit) break
      start(task)
    }
    publish()
    if (running.size === 0) break
    // The first to finish, not all of them: a dependent should start as soon
    // as its last dependency lands.
    await Promise.race(running.values())
  }

  // Let whatever is still in flight settle, so the report describes finished
  // children rather than a snapshot taken while they were still writing.
  if (running.size > 0) await Promise.all(running.values())
  publish()

  return { ok: true, report: assembleReport(tasks, results), state }
}

/**
 * The team's outcome, as the dispatching agent reads it.
 *
 * Every task is named with what happened to it, including the ones that never
 * ran. A summary that listed only successes would let the agent carry on as
 * though the rest had happened.
 */
export function renderTeamReport(report: TeamReport): string {
  const lines: string[] = []
  lines.push(
    report.allDone
      ? `All ${report.completed.length} tasks completed.`
      : `${report.completed.length} completed, ${report.failed.length} failed, ${report.unfinished.length} did not run.`
  )
  for (const one of report.completed) {
    lines.push('', `## ${one.taskId} — completed`, one.output)
  }
  for (const one of report.failed) {
    lines.push('', `## ${one.taskId} — FAILED`, one.output)
  }
  if (report.unfinished.length > 0) {
    lines.push(
      '',
      `## did not run: ${report.unfinished.join(', ')}`,
      'A task these depended on did not complete, or the team was stopped.'
    )
  }
  return lines.join('\n')
}

/**
 * A one-line summary of where a team is, for the Tasks panel.
 *
 * Counts rather than a list: a panel row has one line, and "3 done, 1 running,
 * 2 waiting" is what someone glancing at it needs. The detail is in the
 * children's own rows, which already exist.
 */
export function teamProgress(state: TeamState): string {
  const tally: Record<string, number> = {}
  for (const one of Object.values(state)) {
    tally[one.status] = (tally[one.status] ?? 0) + 1
  }
  const parts: string[] = []
  const say = (status: TaskStatus, label: string) => {
    if (tally[status]) parts.push(`${tally[status]} ${label}`)
  }
  say('completed', 'done')
  say('running', 'running')
  say('pending', 'waiting')
  say('failed', 'failed')
  say('blocked', 'blocked')
  say('cancelled', 'cancelled')
  return parts.join(', ')
}
