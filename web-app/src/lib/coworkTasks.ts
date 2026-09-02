// Derives the Cowork activity list — every unit of work a run spawned — from
// data the run already records. Pure and store-free, like coworkCode.ts, so the
// derivation and its ordering are testable without React or zustand.
//
// Two sources, because Cowork has exactly two kinds of background work:
//
// 1. **Subagents** — `SubagentRun` rows from the run store (live) and from the
//    committed session (finished). These already carry status, queue position,
//    timestamps, usage and their own transcript.
// 2. **Shell commands** — from two sources that describe the same commands.
//    The transcript knows which tool call started one and what it printed; the
//    backend's `bash_jobs_list` knows which are still running right now. The
//    transcript alone cannot say whether a backgrounded command has finished,
//    and the backend alone forgets a job the moment it is collected — so the
//    two are merged, keyed on job id.

import type { CoworkTurn, SubagentRun, Usage } from '@/types/coworkSession'

export type TaskStatus = 'queued' | 'running' | 'done' | 'error'

export type TaskKind = 'subagent' | 'command'

/** One row of the activity list. */
export type TaskRow = {
  /** Stable within a session: the subagent's runId, or the tool call id. */
  id: string
  kind: TaskKind
  /** Subagent name, or the command line. */
  title: string
  status: TaskStatus
  /** Epoch ms. Absent for a command, which records no start time. */
  startedAt?: number
  endedAt?: number
  /** Tokens this unit of work spent, when it reports usage. */
  usage?: Usage
  /** Tool calls made, for a subagent. Commands are themselves one call. */
  toolCount?: number
  /** 1-based queue position while `queued`. */
  waiting?: number
  /** The subagent's own trace, for the expanded transcript view. */
  transcript?: CoworkTurn[]
  /** A subagent's final answer, or a command's output. */
  output?: string
  /** Set when the command was backgrounded by the shell tool's timeout. */
  jobId?: string
}

/**
 * The job id the `bash` tool reports when a command outruns its timeout.
 *
 * Rust prints a fixed sentence ending `(job_id=bash-N)` — see `handlers.rs`'s
 * background branch — and the CLI's TUI recovers the id from the same marker.
 * Matching the literal marker rather than guessing at prose keeps this exactly
 * as reliable as the contract it reads.
 */
export function backgroundJobId(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const match = text.match(/\bjob_id=([A-Za-z0-9_-]+)/)
  return match ? match[1] : null
}

/** How many tool calls a transcript contains. */
export function countToolCalls(turns: CoworkTurn[] | undefined): number {
  return (turns ?? []).filter((turn) => turn.role === 'tool').length
}

/** Total tokens across rows that report usage. */
export function totalTokens(rows: TaskRow[]): number {
  return rows.reduce((sum, row) => sum + (row.usage?.total_tokens ?? 0), 0)
}

/** Elapsed ms for a row: to its end, or to `now` while it is still going. */
export function elapsedMs(row: TaskRow, now: number): number | undefined {
  if (row.startedAt == null) return undefined
  const end = row.endedAt ?? now
  // Clamped: a clock adjustment mid-run must not render a negative duration.
  return Math.max(0, end - row.startedAt)
}

const commandOf = (args: unknown): string | undefined => {
  if (args && typeof args === 'object' && 'command' in args) {
    const value = (args as Record<string, unknown>).command
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

/** Subagent runs as task rows. */
export function subagentTasks(runs: SubagentRun[] | undefined): TaskRow[] {
  return (runs ?? []).map((run) => ({
    id: run.runId,
    kind: 'subagent' as const,
    title: run.name,
    status: run.status as TaskStatus,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    usage: run.usage,
    toolCount: countToolCalls(run.turns),
    waiting: run.waiting,
    transcript: run.turns,
    output: run.finalOutput,
  }))
}

/** The `job_id` a `bash` call passed to collect a backgrounded command. */
const collectedJobId = (args: unknown): string | undefined => {
  if (args && typeof args === 'object' && 'job_id' in args) {
    const value = (args as Record<string, unknown>).job_id
    return typeof value === 'string' && value ? value : undefined
  }
  return undefined
}

/**
 * Shell commands as task rows, read off the parent run's `bash` tool turns.
 *
 * A turn still marked `running` is a command in flight. A finished turn whose
 * result carries a `job_id=` marker did not actually finish — the tool returned
 * early and the command is still going in the background — so it is reported as
 * running rather than done, which is what is actually true of the shell.
 *
 * That marker is permanent in the transcript, so the collection has to be read
 * too: the agent collects with a second `bash` call carrying `job_id`, and once
 * that call completes the command really has finished. Without this a
 * backgrounded command spins in the UI forever, because the backend drops the
 * job the moment it is collected and can no longer report it either.
 */
export function commandTasks(turns: CoworkTurn[] | undefined): TaskRow[] {
  const collected = new Map<string, CoworkTurn>()
  for (const turn of turns ?? []) {
    if (turn.role !== 'tool' || turn.name !== 'bash') continue
    if (turn.status === 'running') continue
    const jobId = collectedJobId(turn.args)
    if (jobId) collected.set(jobId, turn)
  }

  const rows: TaskRow[] = []
  for (const turn of turns ?? []) {
    if (turn.role !== 'tool' || turn.name !== 'bash') continue
    // The collecting call is not a command of its own; it settles the row for
    // the command it collects, which is already listed.
    if (collectedJobId(turn.args)) continue
    const command = commandOf(turn.args)
    const result = turn.result ?? turn.content
    const jobId = backgroundJobId(result)
    const collection = jobId ? collected.get(jobId) : undefined
    const status: TaskStatus = turn.isError
      ? 'error'
      : collection
        ? collection.isError
          ? 'error'
          : 'done'
        : turn.status === 'running' || jobId
          ? 'running'
          : 'done'
    rows.push({
      id: turn.callId ?? `bash-${rows.length}`,
      kind: 'command',
      // A call whose arguments have not finished streaming is still worth
      // listing; the partial JSON is not shown, because it is not a command.
      title: command ?? '…',
      status,
      // The collected output is the command's real output; the early return
      // only said it had been backgrounded.
      output: (collection && (collection.result ?? collection.content)) || result,
      ...(jobId ? { jobId } : {}),
    })
  }
  return rows
}

const STATUS_ORDER: Record<TaskStatus, number> = {
  running: 0,
  queued: 1,
  error: 2,
  done: 3,
}

/**
 * Order for display: what is happening now, then what is waiting, then what is
 * finished, most recent first. Within the queue, by queue position, so the list
 * reads in the order the work will actually run.
 */
export function sortTasks(rows: TaskRow[]): TaskRow[] {
  return [...rows].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    if (byStatus !== 0) return byStatus
    if (a.status === 'queued' && b.status === 'queued') {
      return (a.waiting ?? 0) - (b.waiting ?? 0)
    }
    if (a.status === 'done' || a.status === 'error') {
      return (b.endedAt ?? 0) - (a.endedAt ?? 0)
    }
    return (a.startedAt ?? 0) - (b.startedAt ?? 0)
  })
}

/**
 * Merge the live lane over the committed one.
 *
 * A run that is finishing appears in both: the run store still holds it while
 * the session has already committed it. Keyed by id with the live copy winning,
 * because that is the one still receiving events.
 */
export function mergeTasks(live: TaskRow[], committed: TaskRow[]): TaskRow[] {
  const byId = new Map<string, TaskRow>()
  for (const row of committed) byId.set(row.id, row)
  for (const row of live) byId.set(row.id, row)
  return [...byId.values()]
}

/** A live background job, as the backend reports it. */
export type LiveJob = {
  jobId: string
  command: string
  elapsedMs: number
  finished: boolean
  callId?: string | null
}

/**
 * Fold live backend jobs into rows derived from the transcript.
 *
 * The two describe the same commands from different angles: the transcript
 * knows which tool call started one, the backend knows whether it is still
 * running. A job matches a row by its job id first — that is exact — and by
 * the originating call id second, which is what links a job to the row for the
 * call that backgrounded it. Anything unmatched is a job this session did not
 * start, and is added rather than dropped: it is still running on the
 * machine, which is the whole point of listing it.
 */
export function mergeLiveJobs(
  rows: TaskRow[],
  jobs: LiveJob[],
  now?: number
): TaskRow[] {
  const byJobId = new Map<string, TaskRow>()
  const byCallId = new Map<string, TaskRow>()
  for (const row of rows) {
    if (row.jobId) byJobId.set(row.jobId, row)
    byCallId.set(row.id, row)
  }

  const merged = [...rows]
  for (const job of jobs) {
    const existing =
      byJobId.get(job.jobId) ??
      (job.callId ? byCallId.get(job.callId) : undefined)
    const status: TaskStatus = job.finished ? 'done' : 'running'
    const startedAt = now == null ? undefined : now - job.elapsedMs
    if (existing) {
      const at = merged.indexOf(existing)
      merged[at] = {
        ...existing,
        // The backend is authoritative on whether the shell is still going,
        // except for a call that already failed.
        status: existing.status === 'error' ? 'error' : status,
        jobId: job.jobId,
        startedAt: existing.startedAt ?? startedAt,
      }
      continue
    }
    if (job.finished) continue
    merged.push({
      id: job.jobId,
      kind: 'command',
      title: job.command,
      status,
      jobId: job.jobId,
      startedAt,
    })
  }
  return merged
}

export type TaskTotals = {
  running: number
  queued: number
  finished: number
  tokens: number
  toolCalls: number
}

export function taskTotals(rows: TaskRow[]): TaskTotals {
  return {
    running: rows.filter((r) => r.status === 'running').length,
    queued: rows.filter((r) => r.status === 'queued').length,
    finished: rows.filter((r) => r.status === 'done' || r.status === 'error')
      .length,
    tokens: totalTokens(rows),
    toolCalls: rows.reduce((sum, r) => sum + (r.toolCount ?? 0), 0),
  }
}

/**
 * The whole activity list for a session, ready to render.
 *
 * `liveSubagents` is the run store's lane for this session; `sessionSubagents`
 * and `turns` come off the committed session, so the list survives a reload and
 * a finished run does not empty it.
 */
export function buildTaskList(input: {
  liveSubagents?: SubagentRun[]
  sessionSubagents?: SubagentRun[]
  turns?: CoworkTurn[]
  /** Background jobs the backend reports as still registered. */
  liveJobs?: LiveJob[]
  /** Clock for turning a live job's elapsed time into a start instant. */
  now?: number
}): TaskRow[] {
  const subagents = mergeTasks(
    subagentTasks(input.liveSubagents),
    subagentTasks(input.sessionSubagents)
  )
  const commands = mergeLiveJobs(
    commandTasks(input.turns),
    input.liveJobs ?? [],
    input.now
  )
  return sortTasks([...subagents, ...commands])
}
