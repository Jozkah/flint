/**
 * The campaign scheduler loop, in the renderer (docs/CAMPAIGNS.md).
 *
 * The backend record decides what a task's status is; this module decides what
 * to do next and does it. Everything it touches outside the record goes
 * through a `RunnerHost`, so the logic is tested without stores or Tauri.
 *
 * - `kick` starts every task the scheduler allows: a session on its own
 *   worktree branch, seeded with the brief and context, opened in a pane so
 *   its run can start. Capped by `campaigns.maxParallel` and by free panes.
 * - `onRunEnded` settles a task whose run ended: commit pending work, write
 *   the handoff, record the result and tell the coordinator.
 * - `resume` re-queues what an app restart interrupted.
 *
 * A task run only exists while its session is on screen (the Cowork run loop is
 * renderer-driven), which is why panes bound parallelism.
 */
import { campaignApi, type CampaignApi } from '@/lib/campaignApi'
import {
  nextActions,
  taskModeFor,
  type Campaign,
  type CampaignTask,
} from '@/lib/campaignModel'
import { buildTaskSeed } from '@/lib/campaignSeed'
import type { CoworkMode } from '@/lib/coworkMode'
import type { CampaignLink } from '@/types/coworkSession'
import { errorText } from '@/lib/errorText'

/** What the runner needs from the app, injected so tests need no stores. */
export type RunnerHost = {
  maxParallel: () => number
  /** Session ids with a run in progress. */
  liveSessions: () => ReadonlySet<string>
  /** Panes that may still be opened. */
  freePanes: () => number
  dataFolder: () => Promise<string>
  /** The session's campaign pointer, if it has one. */
  linkOf: (sessionId: string) => CampaignLink | undefined
  sessionExists: (sessionId: string) => boolean
  createTaskSession: (spec: {
    title: string
    folder: string
    mode: CoworkMode
    model?: { provider: string; id: string }
    link: CampaignLink
  }) => string
  deleteSession: (sessionId: string) => void
  /** Open the session in a pane so its run can start. */
  openPane: (sessionId: string) => 'added' | 'filled' | 'shown' | 'full'
  ensureWorktree: (
    sessionId: string,
    project: string,
    dataFolder: string,
    options: { title?: string; base?: string }
  ) => Promise<
    | { ok: true; record: { path: string; branch: string; baseSha: string } }
    | { ok: false; reason: string }
  >
  /** Grant the worktree to the session and switch it to managed-worktree. */
  attachWorktree: (
    sessionId: string,
    path: string,
    dataFolder: string
  ) => Promise<{ ok: true } | { ok: false; reason: string }>
  registerMailbox: (sessionId: string, title: string, folder: string) => Promise<void>
  /** Put the first turn in the session's queue, ready. */
  enqueueSeed: (sessionId: string, text: string) => void
  worktreeRecordFor: (sessionId: string) => unknown
  commitPending: (
    record: unknown,
    dataFolder: string,
    message: string
  ) => Promise<boolean>
  unmergedCommits: (record: unknown) => Promise<string[]>
  /** How the session's last run ended, and what it said last. */
  endOf: (sessionId: string) => {
    stoppedBy: string
    errorText?: string
    lastReply: string
    tokens: number
  }
  abortRun: (sessionId: string) => void
  /** A short notice for the coordinator, delivered at its next step boundary. */
  notifyCoordinator: (coordinatorSessionId: string, text: string) => void
}

export type RunnerResult = { started: string[]; blocked: string[] }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s)

/** Small, stable, non-cryptographic digest of what a task left behind. */
export function fingerprintOf(lines: string[]): string {
  let h = 0x811c9dc5
  for (const ch of lines.join('\n')) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `fnv1a:${h.toString(16)}:${lines.length}`
}

function parseModel(
  raw: string
): { provider: string; id: string } | undefined {
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) return undefined
  return { provider: raw.slice(0, slash), id: raw.slice(slash + 1) }
}

export function createCampaignRunner(
  host: RunnerHost,
  api: CampaignApi = campaignApi
) {
  /** One decision at a time per campaign, so two kicks cannot double-start. */
  const chains = new Map<string, Promise<unknown>>()
  const serialize = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const next = (chains.get(id) ?? Promise.resolve()).then(work, work)
    chains.set(
      id,
      next.catch(() => undefined)
    )
    return next
  }

  const parkTask = (c: Campaign, task: CampaignTask, reason: string) =>
    api
      .transition(c.id, {
        task: { id: task.id, to: 'blocked', patch: { detail: clip(reason, 1000) } },
      })
      .catch(() => undefined)

  const startTask = async (c: Campaign, task: CampaignTask): Promise<boolean> => {
    // Queued first: a crash from here on leaves a record that says so.
    if (task.status === 'pending') {
      await api.transition(c.id, { task: { id: task.id, to: 'queued' } })
    }
    let dataFolder = ''
    try {
      dataFolder = await host.dataFolder()
    } catch {
      /* handled below */
    }
    if (!dataFolder) {
      await parkTask(c, task, 'the app data folder is not available')
      return false
    }
    if (!c.integrationBranch) {
      await parkTask(c, task, 'the campaign has no integration branch')
      return false
    }

    // An interrupted task goes on in the session it already has, on the
    // worktree it already has; nothing it did is thrown away.
    const reused =
      task.sessionId && host.sessionExists(task.sessionId)
        ? task.sessionId
        : undefined
    const sessionId =
      reused ??
      host.createTaskSession({
        title: `${c.title}: ${task.title}`.slice(0, 120),
        folder: c.sourceRoot,
        // Never above the ceiling and never bypass, whatever the coordinator ran in.
        mode: taskModeFor(c.modeCeiling),
        model: parseModel(c.model),
        link: { id: c.id, taskId: task.id, role: 'task' },
      })
    const discard = async (reason: string) => {
      if (!reused) host.deleteSession(sessionId)
      await parkTask(c, task, reason)
      return false
    }

    const made = await host.ensureWorktree(sessionId, c.sourceRoot, dataFolder, {
      title: task.title,
      base: c.integrationBranch,
    })
    if (!made.ok) return discard(`worktree: ${made.reason}`)
    const attached = await host.attachWorktree(
      sessionId,
      made.record.path,
      dataFolder
    )
    if (!attached.ok) return discard(`worktree access: ${attached.reason}`)
    try {
      await host.registerMailbox(
        sessionId,
        `${c.title}: ${task.title}`.slice(0, 120),
        c.sourceRoot
      )
    } catch (e) {
      return discard(`mailbox: ${errorText(e)}`)
    }

    const upstream = task.dependsOn
    let context = { decisions: '', handoffs: [] as { taskId: string; text: string }[] }
    try {
      context = await api.context(c.id, upstream)
    } catch {
      // A seed without context is still a valid assignment.
    }
    const seed = buildTaskSeed({
      campaign: c,
      task,
      branch: made.record.branch,
      context,
    })
    host.enqueueSeed(
      sessionId,
      reused
        ? 'Your previous run of this task was interrupted when the app ' +
            'stopped. Look at your worktree (git status, git log) and ' +
            'continue from where it stopped; do not redo finished work.\n\n' +
            seed
        : seed
    )

    if (host.openPane(sessionId) === 'full') {
      return discard('no free pane to run in')
    }
    await api.transition(c.id, {
      task: {
        id: task.id,
        to: 'running',
        patch: {
          sessionId,
          branch: made.record.branch,
          worktreePath: made.record.path,
          baseSha: made.record.baseSha,
        },
      },
    })
    return true
  }

  const tick = async (id: string): Promise<RunnerResult> => {
    const result: RunnerResult = { started: [], blocked: [] }
    let c = await api.get(id)
    if (c.status !== 'running') return result
    const live = host.liveSessions()
    const liveTasks = c.tasks
      .filter((t) => t.sessionId && live.has(t.sessionId))
      .map((t) => t.id)
    const actions = nextActions(
      c,
      { liveTasks, freePanes: host.freePanes() },
      host.maxParallel()
    )
    for (const a of actions) {
      const task = c.tasks.find((t) => t.id === a.taskId)
      if (!task) continue
      if (a.action === 'block') {
        await parkTask(c, task, a.because)
        result.blocked.push(task.id)
        continue
      }
      try {
        if (await startTask(c, task)) result.started.push(task.id)
      } catch (e) {
        await parkTask(c, task, `could not start: ${errorText(e)}`)
      }
      // The record moved under us; later decisions read the latest.
      c = await api.get(id)
    }
    return result
  }

  /** Start whatever the scheduler allows for one campaign. */
  const kick = (id: string): Promise<RunnerResult> =>
    serialize(id, () => tick(id))

  /**
   * A task session's run ended: commit its work, record how it ended with a
   * handoff, and tell the coordinator. Idempotent: the backend keeps the first
   * ending, and the notice is recorded once.
   */
  const onRunEnded = (sessionId: string): Promise<void> => {
    const link = host.linkOf(sessionId)
    if (!link || link.role !== 'task' || !link.taskId) return Promise.resolve()
    const { id, taskId } = link
    return serialize(id, async () => {
      let c: Campaign
      try {
        c = await api.get(id)
      } catch {
        return
      }
      const task = c.tasks.find((t) => t.id === taskId)
      if (!task || task.sessionId !== sessionId) return
      // Only a task the record still believes is live is settled by a run end.
      if (
        task.status !== 'running' &&
        task.status !== 'awaiting_input' &&
        task.status !== 'awaiting_approval'
      ) {
        return
      }

      const end = host.endOf(sessionId)
      const outcome =
        end.stoppedBy === 'done'
          ? 'completed'
          : end.stoppedBy === 'aborted'
            ? 'cancelled'
            : 'failed'

      let commits: string[] = []
      let note = ''
      const record = host.worktreeRecordFor(sessionId)
      if (record) {
        try {
          const dataFolder = await host.dataFolder()
          await host.commitPending(
            record,
            dataFolder,
            `${c.title}: ${task.title}`.slice(0, 200)
          )
        } catch (e) {
          note = `Pending changes could not be committed: ${errorText(e)}`
        }
        try {
          commits = await host.unmergedCommits(record)
        } catch {
          /* the handoff just lists no commits */
        }
      }

      const handoff = [
        `# Handoff: ${task.title}`,
        `Outcome: ${outcome}${end.errorText ? ` (${clip(end.errorText, 300)})` : ''}`,
        '',
        '## Final message',
        clip(end.lastReply.trim() || '(the task ended without a final message)', 8000),
        '',
        '## Commits on the task branch',
        commits.length > 0 ? commits.map((l) => `- ${l}`).join('\n') : '(none)',
        ...(note ? ['', note] : []),
      ].join('\n')

      const detail =
        outcome === 'completed'
          ? 'run finished'
          : clip(end.errorText ?? `run ended: ${end.stoppedBy}`, 500)
      try {
        await api.settle(id, taskId, {
          outcome,
          detail,
          handoff,
          tokensUsed: end.tokens,
          fingerprint: fingerprintOf(commits),
        })
      } catch {
        return
      }

      host.notifyCoordinator(
        c.coordinatorSession,
        `Campaign "${c.title}" task '${task.id}' (${task.title}) ${outcome}` +
          (commits.length > 0 ? ` with ${commits.length} commit(s)` : '') +
          `. Read it with campaign_collect.`
      )
      await api.notified(id, taskId).catch(() => undefined)
      await tick(id).catch(() => undefined)
    })
  }

  /**
   * After a restart: re-queue what was interrupted and run again. Unfinished
   * work is never treated as clean; interrupted tasks start from their
   * existing worktree (ensure is idempotent).
   */
  const resume = (id: string): Promise<RunnerResult> =>
    serialize(id, async () => {
      const c = await api.get(id)
      if (c.status === 'interrupted') {
        await api.transition(id, { campaign: 'running' })
      } else if (c.status !== 'running') {
        return { started: [], blocked: [] }
      }
      const fresh = await api.get(id)
      for (const t of fresh.tasks) {
        if (t.status === 'interrupted') {
          await api
            .transition(id, { task: { id: t.id, to: 'queued' } })
            .catch(() => undefined)
        }
      }
      return tick(id)
    })

  /**
   * Cancel a campaign: the backend marks every unfinished task cancelled, and
   * the runs still going are aborted here. Worktrees stay until the user
   * discards them.
   */
  const cancel = async (id: string, detail?: string): Promise<Campaign> => {
    const before = await api.get(id)
    const cancelled = await api.cancel(id, detail)
    for (const t of before.tasks) {
      if (t.sessionId && host.liveSessions().has(t.sessionId)) {
        host.abortRun(t.sessionId)
      }
    }
    return cancelled
  }

  /**
   * Push a notice for every task that ended while nobody was told, from the
   * persisted event log. Safe to run on every startup.
   */
  const repushNotices = async (id: string): Promise<number> => {
    const [c, events] = await Promise.all([api.get(id), api.events(id)])
    const told = new Set(
      events.filter((e) => e.kind === 'coordinator-notified').map((e) => e.task)
    )
    let pushed = 0
    for (const t of c.tasks) {
      if (told.has(t.id)) continue
      if (t.status !== 'completed' && t.status !== 'failed') continue
      host.notifyCoordinator(
        c.coordinatorSession,
        `Campaign "${c.title}" task '${t.id}' (${t.title}) ${t.status}. ` +
          'Read it with campaign_collect.'
      )
      await api.notified(id, t.id).catch(() => undefined)
      pushed += 1
    }
    return pushed
  }

  return { kick, onRunEnded, resume, cancel, repushNotices }
}

export type CampaignRunner = ReturnType<typeof createCampaignRunner>
