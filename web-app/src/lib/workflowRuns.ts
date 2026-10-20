/**
 * Saved results of a `workflow` run, so a stopped or failed run can be
 * relaunched without redoing finished work (docs/WORKFLOWS.md, section 2).
 *
 * The rule is Claude Code's: replay in start order; an agent whose brief hash
 * matches returns its saved result, the first that differs (or is missing,
 * failed, or was still running) runs again and so does everything that starts
 * after it. Pure apart from [`RunIo`], which is the only thing that touches the
 * app data folder (never an attached project folder).
 */
import { invoke } from '@tauri-apps/api/core'
import { getServiceHub } from '@/hooks/useServiceHub'
import type { TaskResult, TeamTask } from '@/lib/coworkTeam'

export const RUN_DIR = 'workflow-runs'
/** A result larger than this is not stored: it reruns instead of being truncated. */
export const MAX_ENTRY_CHARS = 64 * 1024
/** A record stops accepting entries here. */
export const MAX_RECORD_CHARS = 2 * 1024 * 1024
export const MAX_RUN_AGE_MS = 14 * 24 * 3600 * 1000
export const MAX_RUN_FILES = 50

export type RunEntry = { hash: string; output: string; seq: number }

export type RunRecord = {
  v: 1
  runId: string
  sessionId: string
  createdAt: number
  updatedAt: number
  /** The validated phases as launched; relaunching without `phases` reuses them. */
  phases: unknown[]
  /** The `args` the phases' `{{args.x}}` placeholders were filled from. */
  args?: Record<string, unknown>
  entries: Record<string, RunEntry>
}

/** The folder access this module needs; one real implementation, one in tests. */
export type RunIo = {
  dir: string
  mkdir(path: string): Promise<void>
  list(path: string): Promise<string[]>
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
}

/** The id a run goes by: its call id reduced to filename-safe characters. */
export const safeId = (raw: string): string =>
  raw.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)

/** Two 53-bit string hashes joined: detects edits, not adversaries. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  let g1 = 0x9e3779b9
  let g2 = 0x85ebca6b
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
    g1 = Math.imul(g1 ^ ch, 2246822507)
    g2 = Math.imul(g2 ^ ch, 3266489909)
  }
  const mix = (a: number, b: number) => {
    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909)
    b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909)
    return 4294967296 * (2097151 & b) + (a >>> 0)
  }
  return `${mix(h1, h2).toString(36)}${mix(g1, g2).toString(36)}`
}

/** What an agent's saved result is keyed on: the brief it would get, and how it runs. */
export function briefHash(task: TeamTask): string {
  return hashText(
    JSON.stringify([task.description, task.subagentName ?? '', task.model ?? '', task.schema ?? null])
  )
}

export const entryKey = (task: Pick<TeamTask, 'id' | 'phase'>): string =>
  `${task.phase?.index ?? 0}:${task.id}`

const fileName = (record: Pick<RunRecord, 'createdAt' | 'sessionId' | 'runId'>) =>
  `${record.createdAt.toString(36)}__${safeId(record.sessionId)}__${safeId(record.runId)}.json`

const parseRecord = (text: string, sessionId: string): RunRecord | null => {
  try {
    const one = JSON.parse(text) as Partial<RunRecord> | null
    if (
      !one ||
      one.v !== 1 ||
      one.sessionId !== sessionId ||
      typeof one.runId !== 'string' ||
      !Array.isArray(one.phases) ||
      !one.entries ||
      typeof one.entries !== 'object'
    ) {
      return null
    }
    return one as RunRecord
  } catch {
    return null
  }
}

/** The saved record of a run in this session, newest first when a name repeats. */
export async function loadRun(
  io: RunIo,
  sessionId: string,
  runId: string
): Promise<RunRecord | null> {
  const suffix = `__${safeId(sessionId)}__${safeId(runId)}.json`
  let names: string[] = []
  try {
    names = await io.list(io.dir)
  } catch {
    return null
  }
  const mine = names
    .map((path) => ({ path, name: path.split(/[\\/]/).pop() ?? '' }))
    .filter((one) => one.name.endsWith(suffix))
    .sort((a, b) => b.name.localeCompare(a.name))
  for (const one of mine) {
    try {
      const record = parseRecord(await io.read(one.path), sessionId)
      if (record) return record
    } catch {
      // Unreadable: try the next, or report nothing to resume.
    }
  }
  return null
}

/** Delete records past the age or count bound. Best effort. */
export async function pruneRuns(io: RunIo, now = Date.now()): Promise<void> {
  let names: string[] = []
  try {
    names = await io.list(io.dir)
  } catch {
    return
  }
  const dated = names
    .map((path) => {
      const name = path.split(/[\\/]/).pop() ?? ''
      const created = parseInt(name.split('__')[0], 36)
      return { path, name, created: Number.isFinite(created) ? created : 0 }
    })
    .filter((one) => one.name.endsWith('.json') && one.name.includes('__'))
    .sort((a, b) => b.created - a.created)
  const doomed = dated.filter((one, i) => i >= MAX_RUN_FILES || now - one.created > MAX_RUN_AGE_MS)
  for (const one of doomed) await io.remove(one.path).catch(() => {})
}

/**
 * One run's log: decides what a replay returns and records what completed.
 * Everything it does is best effort: a store that cannot be written costs the
 * ability to resume, never the run.
 */
export class WorkflowRunLog {
  private readonly record: RunRecord
  private tainted = false
  private seq = 0
  private chars = 0
  private chain: Promise<void> = Promise.resolve()
  private prepared = false
  replayed = 0
  reran = 0

  constructor(
    private readonly io: RunIo | null,
    meta: { sessionId: string; runId: string; phases: unknown[]; args?: Record<string, unknown>; now?: number },
    private readonly from: RunRecord | null = null
  ) {
    const now = meta.now ?? Date.now()
    this.record = {
      v: 1,
      runId: safeId(meta.runId),
      sessionId: meta.sessionId,
      createdAt: now,
      updatedAt: now,
      phases: meta.phases,
      ...(meta.args ? { args: meta.args } : {}),
      entries: {},
    }
  }

  get runId(): string {
    return this.record.runId
  }

  get replaying(): boolean {
    return this.from !== null
  }

  /**
   * The saved result for this agent, or null when it must run. Call it in start
   * order, synchronously at the start of each agent: the first miss makes every
   * later call a miss too.
   */
  decide(task: TeamTask): { output: string } | null {
    if (!this.from) return null
    if (!this.tainted) {
      const saved = this.from.entries[entryKey(task)]
      if (saved && saved.hash === briefHash(task)) {
        this.replayed += 1
        return { output: saved.output }
      }
      this.tainted = true
    }
    this.reran += 1
    return null
  }

  /** Keep a completed result for a later relaunch. */
  save(task: TeamTask, result: Pick<TaskResult, 'ok' | 'output' | 'destination'>): void {
    if (!this.io || !result.ok || result.destination || task.isolate) return
    if (result.output.length > MAX_ENTRY_CHARS) return
    if (this.chars + result.output.length > MAX_RECORD_CHARS) return
    this.chars += result.output.length
    this.seq += 1
    this.record.entries[entryKey(task)] = {
      hash: briefHash(task),
      output: result.output,
      seq: this.seq,
    }
    this.record.updatedAt = Date.now()
    this.flush()
  }

  /** Wait for writes in flight. */
  settled(): Promise<void> {
    return this.chain
  }

  private flush(): void {
    const io = this.io
    if (!io) return
    this.chain = this.chain
      .then(async () => {
        if (!this.prepared) {
          this.prepared = true
          await io.mkdir(io.dir)
          await pruneRuns(io)
        }
        await io.write(`${io.dir}/${fileName(this.record)}`, JSON.stringify(this.record))
      })
      .catch(() => {})
  }

  /** One line for the report: what a replay did. */
  summary(): string {
    if (!this.from) return ''
    return `Resumed run ${this.from.runId}: ${this.replayed} agent${this.replayed === 1 ? '' : 's'} returned saved results, ${this.reran} ran again.`
  }
}

/**
 * Wrap a team's `runTask` so a replay returns saved results and every
 * completed agent is kept. `onReplayed` lets the caller draw a finished row for
 * an agent that never ran.
 */
export function withRunLog(
  log: WorkflowRunLog,
  runTask: (task: TeamTask, signal: AbortSignal) => Promise<TaskResult>,
  onReplayed?: (task: TeamTask, output: string) => void
): (task: TeamTask, signal: AbortSignal) => Promise<TaskResult> {
  return (task, signal) => {
    const hit = log.decide(task)
    if (hit) {
      log.save(task, { ok: true, output: hit.output })
      onReplayed?.(task, hit.output)
      return Promise.resolve({
        taskId: task.id,
        ok: true,
        output: hit.output,
        producedBy: `${task.id} (saved result)`,
      })
    }
    return runTask(task, signal).then((result) => {
      log.save(task, result)
      return result
    })
  }
}

/** The real folder access: the app data folder, through its confined commands. */
export async function dataFolderIo(subdir: string = RUN_DIR): Promise<RunIo | null> {
  try {
    const folder = (await getServiceHub().app().getJanDataFolder())?.replace(/[\\/]+$/, '')
    if (!folder) return null
    return {
      dir: `${folder}/${subdir}`,
      mkdir: (path) => invoke('mkdir', { args: [path] }),
      list: (path) => invoke<string[]>('readdir_sync', { args: [path] }),
      read: (path) => invoke<string>('read_file_sync', { args: [path] }),
      write: (path, content) => invoke('write_file_sync', { args: [path, content] }),
      remove: (path) => invoke('rm', { args: [path] }),
    }
  } catch {
    return null
  }
}

/**
 * Fill in a `resume_run_id` call: the saved phases when the call gave none.
 * An error sentence when there is nothing to resume.
 */
export async function resolveResume(
  sessionId: string | undefined,
  input: unknown,
  io?: RunIo | null
): Promise<{ input: unknown } | { error: string }> {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const id = typeof raw.resume_run_id === 'string' ? raw.resume_run_id.trim() : ''
  if (raw.resume_run_id !== undefined && !id) return { error: '`resume_run_id` is empty' }
  if (!id) return { input }
  const store = io === undefined ? await dataFolderIo() : io
  const record = sessionId && store ? await loadRun(store, sessionId, id) : null
  if (!record) {
    return {
      error: `nothing to resume: no saved run '${id}' in this chat. Start the workflow again as a new run.`,
    }
  }
  return { input: { ...raw, phases: raw.phases ?? record.phases, ...(raw.args === undefined && record.args ? { args: record.args } : {}) } }
}

/**
 * Open the log for a workflow run about to start: a replay of `resumeRunId` when
 * the call named one (its record was already checked by [`resolveResume`]).
 */
export async function openRunLog(
  sessionId: string,
  runId: string,
  run: { phases: unknown[]; args?: Record<string, unknown>; resumeRunId?: string },
  io?: RunIo | null
): Promise<WorkflowRunLog> {
  const store = io === undefined ? await dataFolderIo() : io
  const from =
    store && run.resumeRunId ? await loadRun(store, sessionId, run.resumeRunId) : null
  return new WorkflowRunLog(store, { sessionId, runId, phases: run.phases, args: run.args }, from)
}
