/**
 * Verify, resolve, merge: the runner's decisions after a task completes. Split
 * out of the runner (campaignRunner.ts). State shared with the rest of the
 * runner (the per-campaign chain, start times) is owned there and passed in.
 */
import type {
  CampaignApi,
  IntegrateReport,
  MergeReport,
  ResolvePlan,
  VerifyOutcome,
} from '@/lib/campaignApi'
import {
  isServerDriven,
  taskModeFor,
  type Campaign,
  type CampaignTask,
} from '@/lib/campaignModel'
import { errorText } from '@/lib/errorText'
import type { RunnerHost, RunnerResult } from '@/lib/campaignRunner'
import {
  VERDICT_REMINDER,
  clip,
  excerptOf,
  findVerdict,
  parseModel,
} from '@/lib/campaign/runnerText'

export type VerifyMergeContext = {
  host: RunnerHost
  api: CampaignApi
  now: () => number
  serialize: <T>(id: string, work: () => Promise<T>) => Promise<T>
  tellCoordinator: (
    c: Campaign,
    text: string,
    fromSessionId?: string
  ) => Promise<void>
  tick: (id: string) => Promise<RunnerResult>
  kick: (id: string) => Promise<RunnerResult>
  /** When this process started each task, for the pane-closed check. */
  startedAt: Map<string, number>
}

export function createVerifyMerge(ctx: VerifyMergeContext) {
  const { host, api, now, serialize, tellCoordinator, tick, kick, startedAt } =
    ctx
  const verifying = new Set<string>()

  const reviewingNotice = async (c: Campaign) => {
    await tellCoordinator(
      c,
      `Campaign "${c.title}": every task is merged into ${c.integrationBranch}. ` +
        'Call campaign_merge with finalize=true to run the build and test gate ' +
        'and propose the result to the user.',
      undefined
    )
  }

  /**
   * Start a resolver for a conflicted task: a new session on a fresh worktree
   * branched from the integration branch with the task's branch merged in and
   * the conflict left for it. One attempt per conflict; it is verified and
   * merged like any task. Not serialized: callers are inside the chain.
   */
  const resolveOne = async (
    c: Campaign,
    task: CampaignTask
  ): Promise<
    { ok: true; plan: ResolvePlan } | { ok: false; reason: string }
  > => {
    if (task.status !== 'conflict') {
      return {
        ok: false,
        reason: `task ${task.id} is ${task.status}, not conflicted`,
      }
    }
    if ((task.resolver?.attempts ?? 0) >= 1) {
      return { ok: false, reason: 'a resolver already tried this conflict' }
    }
    let dataFolder = ''
    try {
      dataFolder = await host.dataFolder()
    } catch {
      /* handled below */
    }
    if (!dataFolder)
      return { ok: false, reason: 'the app data folder is not available' }
    const title = `${c.title}: resolve ${task.title}`.slice(0, 120)
    const sessionId = host.createTaskSession({
      title,
      folder: c.sourceRoot,
      mode: taskModeFor(c.modeCeiling),
      model: parseModel(c.model),
      link: { id: c.id, taskId: task.id, role: 'task' },
    })
    let plan: ResolvePlan
    try {
      plan = await api.resolve(c.id, task.id, sessionId)
    } catch (e) {
      host.deleteSession(sessionId)
      return { ok: false, reason: errorText(e) }
    }
    const back = async (reason: string) => {
      await api
        .transition(c.id, {
          task: {
            id: task.id,
            to: 'conflict',
            patch: { detail: clip(reason, 500) },
          },
        })
        .catch(() => undefined)
      return { ok: false as const, reason }
    }
    const attached = await host.attachWorktree(
      sessionId,
      plan.worktreePath,
      dataFolder
    )
    if (!attached.ok)
      return back(`resolver worktree access: ${attached.reason}`)
    try {
      await host.registerMailbox(sessionId, title, c.sourceRoot)
    } catch (e) {
      return back(`resolver mailbox: ${errorText(e)}`)
    }
    host.enqueueSeed(sessionId, plan.brief)
    if (host.openPane(sessionId) === 'full') {
      return back('no free pane for the resolver')
    }
    startedAt.set(task.id, now())
    await api.transition(c.id, { task: { id: task.id, to: 'running' } })
    return { ok: true, plan }
  }

  /** Start resolvers for every newly conflicted task, when that is switched on. */
  const autoResolve = async (c: Campaign, taskIds: string[]) => {
    if (host.autoResolve && !host.autoResolve()) return
    for (const taskId of taskIds) {
      const fresh = await api.get(c.id).catch(() => c)
      const task = fresh.tasks.find((t) => t.id === taskId)
      if (!task || task.status !== 'conflict' || task.resolver) continue
      const r = await resolveOne(fresh, task)
      await tellCoordinator(
        fresh,
        r.ok
          ? `Campaign "${fresh.title}": task '${taskId}' conflicted with merged work; a resolver session started for ${r.plan.files.join(', ') || 'it'}.`
          : `Campaign "${fresh.title}": task '${taskId}' conflicts and no resolver could start (${r.reason}). Steer it, or skip it with campaign_merge skip=[...].`,
        undefined
      )
    }
  }

  /** Resolve the named conflicted tasks (default: every conflicted one). */
  const resolve = (id: string, taskIds?: string[]) =>
    serialize(id, async () => {
      const c = await api.get(id)
      const wanted = c.tasks.filter(
        (t) =>
          t.status === 'conflict' &&
          (!taskIds?.length || taskIds.includes(t.id))
      )
      const results: {
        taskId: string
        started: boolean
        reason?: string
        files?: string[]
      }[] = []
      for (const t of wanted) {
        const r = await resolveOne(await api.get(id), t)
        results.push(
          r.ok
            ? { taskId: t.id, started: true, files: r.plan.files }
            : { taskId: t.id, started: false, reason: r.reason }
        )
      }
      return results
    })

  /** Merge what is verified, in dependency order, then start what that unblocked. */
  const integrate = (id: string): Promise<IntegrateReport> =>
    serialize(id, async () => {
      const report = await api.integrate(id)
      if (report.merged.length > 0) {
        await tick(id).catch(() => undefined)
      }
      const c = report.campaign
      if (report.conflicts.length > 0) {
        await tellCoordinator(
          c,
          `Campaign "${c.title}": merge conflict in task ` +
            report.conflicts
              .map((x) => `'${x.taskId}' (${x.files.slice(0, 5).join(', ')})`)
              .join(', ') +
            '. Nothing was changed. A resolver session is started for it; if it cannot, steer it or skip it with campaign_merge skip=[...].',
          undefined
        )
        await autoResolve(
          c,
          report.conflicts.map((x) => x.taskId)
        ).catch(() => undefined)
      }
      if (report.merged.length > 0 && c.status === 'reviewing') {
        await reviewingNotice(c)
      }
      return report
    })

  const mergeOne = (id: string, taskId: string): Promise<MergeReport> =>
    serialize(id, async () => {
      const r = await api.mergeTask(id, taskId)
      if (r.merged) await tick(id).catch(() => undefined)
      if (!r.merged && r.conflicts.length > 0) {
        await autoResolve(await api.get(id), [taskId]).catch(() => undefined)
      }
      if (r.merged && r.campaignStatus === 'reviewing') {
        await reviewingNotice(await api.get(id))
      }
      return r
    })

  /**
   * Verify one completed task. FAIL or PARTIAL gets one repair round (the
   * task is queued again in its own session with the findings), then fails.
   * BLOCKED, an unreachable model or a missing verdict never merges. A PASS
   * merges into the integration branch.
   */
  const verifyTask = async (
    id: string,
    taskId: string
  ): Promise<VerifyOutcome | { skipped: string }> => {
    const key = `${id}/${taskId}`
    if (verifying.has(key)) return { skipped: 'already being verified' }
    verifying.add(key)
    try {
      const c = await api.get(id)
      if (isServerDriven(c)) return { skipped: 'the server verifies this campaign' }
      const task = c.tasks.find((t) => t.id === taskId)
      if (!task) return { skipped: 'no such task' }
      if (task.status !== 'completed') {
        return { skipped: `task is ${task.status}, not completed` }
      }
      if (!host.askVerifier)
        return { skipped: 'no model is available to verify' }
      const modelId = parseModel(c.model)?.id ?? ''
      let prepared
      try {
        prepared = await api.verifyPrepare(id, taskId, modelId, true)
      } catch (e) {
        // The backend recorded why it could not be trusted; it stays completed.
        await tellCoordinator(
          c,
          `Campaign "${c.title}" task '${taskId}' could not be verified: ${clip(errorText(e), 300)}`,
          undefined
        )
        return { skipped: errorText(e) }
      }
      let reply: string | null = null
      let error: string | null = null
      let tokens = 0
      try {
        const r = await host.askVerifier(prepared.request, c)
        reply = r.text
        tokens = r.tokens
        // No verdict in the reply: one more try with a reminder appended.
        if (!findVerdict(reply)) {
          const again = await host.askVerifier(
            {
              messages: [
                ...prepared.request.messages,
                { role: 'assistant', content: excerptOf(reply) || '(no answer)' },
                { role: 'user', content: VERDICT_REMINDER },
              ],
            },
            c
          )
          tokens += again.tokens
          if (findVerdict(again.text)) reply = again.text
        }
      } catch (e) {
        error = errorText(e) || 'the verifier could not run'
      }
      const out = await api.verifyFinish(id, taskId, reply, error, tokens)
      const fresh = out.campaign
      if (out.next === 'verified') {
        await integrate(id).catch((e) =>
          tellCoordinator(
            fresh,
            `Campaign "${fresh.title}" task '${taskId}' passed verification but could not merge: ${clip(errorText(e), 300)}`,
            undefined
          )
        )
      } else if (out.next === 'repair') {
        await tellCoordinator(
          fresh,
          `Campaign "${fresh.title}" task '${taskId}' did not pass verification (${out.verdict}); one repair round started.`,
          undefined
        )
        await kick(id).catch(() => undefined)
      } else {
        const blocked = out.next === 'blocked'
        const waiting = fresh.tasks
          .filter((t) => t.dependsOn.includes(taskId))
          .map((t) => t.id)
        await tellCoordinator(
          fresh,
          `Campaign "${fresh.title}" task '${taskId}' ${
            out.next === 'failed' ? 'failed' : 'is not verified'
          } (${out.verdict}). It will not merge. Read it with campaign_collect.` +
            (blocked
              ? ' The check could not decide, so the task waits for a person' +
                (waiting.length > 0
                  ? ` and holds up ${waiting.join(', ')}`
                  : '') +
                '. You can run campaign_verify again; only the user can accept it anyway or skip it from the board.'
              : ''),
          undefined
        )
      }
      return out
    } finally {
      verifying.delete(key)
    }
  }

  /** Verify every completed task (or the named ones). */
  const verify = async (id: string, taskIds?: string[]) => {
    const c = await api.get(id)
    const wanted = c.tasks.filter(
      (t) =>
        t.status === 'completed' && (!taskIds?.length || taskIds.includes(t.id))
    )
    const results: {
      taskId: string
      result: VerifyOutcome | { skipped: string }
    }[] = []
    for (const t of wanted) {
      results.push({ taskId: t.id, result: await verifyTask(id, t.id) })
    }
    return results
  }

  return { resolve, integrate, mergeOne, verifyTask, verify }
}
