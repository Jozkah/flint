/**
 * Limits, waiting state and closed panes for a campaign's live tasks. Split
 * out of the runner (campaignRunner.ts); the maps are owned by the runner and
 * passed in by reference.
 */
import type { CampaignApi } from '@/lib/campaignApi'
import { isLiveTask, isServerDriven, type Campaign } from '@/lib/campaignModel'
import type { RunnerHost, RunnerResult } from '@/lib/campaignRunner'

/** How long after starting a task its run may take to appear before the pane is judged closed. */
export const START_GRACE_MS = 15_000

export type SweepContext = {
  host: RunnerHost
  api: CampaignApi
  now: () => number
  serialize: <T>(id: string, work: () => Promise<T>) => Promise<T>
  tick: (id: string) => Promise<RunnerResult>
  announce: (c: Campaign) => Promise<boolean>
  /** Why a run was stopped by a limit, read when its end is settled. */
  limitReasons: Map<string, string>
  /** When this process started each task, for the pane-closed check. */
  startedAt: Map<string, number>
}

export function createSweeper(ctx: SweepContext) {
  const { host, api, now, tick, announce, limitReasons, startedAt } = ctx

  /**
   * One pass over a campaign's live tasks: stop a run that went over its
   * wall-clock, step or token limit (it fails with that reason), mirror who a
   * run waits on, and re-queue a task whose pane closed before its run began.
   */
  const sweep = (id: string): Promise<void> =>
    ctx.serialize(id, async () => {
      const c = await api.get(id)
      if (isServerDriven(c)) return
      if (c.status !== 'running') {
        await announce(c).catch(() => undefined)
        return
      }
      const t0 = now()
      const live = host.liveSessions()
      for (const t of c.tasks) {
        if (!isLiveTask(t.status) || !t.sessionId) continue
        const sid = t.sessionId
        const running = live.has(sid)

        if (running) {
          const info = host.runInfo?.(sid)
          if (info) {
            const secs = c.limits.wallClockSecs
            const steps = c.limits.taskSteps
            const tokens = c.limits.taskTokens
            const why =
              secs && t0 - info.startedAt > secs * 1000
                ? `wall-clock limit of ${secs}s reached`
                : steps && info.steps >= steps
                  ? `step limit of ${steps} reached`
                  : tokens && info.tokens >= tokens
                    ? `token limit of ${tokens} reached`
                    : null
            if (why && !limitReasons.has(sid)) {
              limitReasons.set(sid, why)
              host.abortRun(sid)
              continue
            }
          }
          const waiting = host.waitingOn?.(sid) ?? null
          const want =
            waiting === 'approval'
              ? 'awaiting_approval'
              : waiting === 'input'
                ? 'awaiting_input'
                : 'running'
          if (want !== t.status) {
            // A waiting task goes back through `running` before another wait.
            if (t.status !== 'running' && want !== 'running') {
              await api
                .transition(id, { task: { id: t.id, to: 'running' } })
                .catch(() => undefined)
            }
            await api
              .transition(id, { task: { id: t.id, to: want } })
              .catch(() => undefined)
          }
          continue
        }

        // No run. If it ended, onRunEnded settles it. If it never began and
        // nobody can see the session, the pane was closed: queue it again.
        if (host.hasEnded?.(sid)) continue
        if (host.isShown?.(sid) !== false) continue
        const began = startedAt.get(t.id)
        if (began !== undefined && t0 - began < START_GRACE_MS) continue
        await api
          .transition(id, { task: { id: t.id, to: 'interrupted' } })
          .catch(() => undefined)
        await api
          .transition(id, {
            task: {
              id: t.id,
              to: 'queued',
              patch: { detail: 'its pane closed before the run started' },
            },
          })
          .catch(() => undefined)
      }
      await tick(id).catch(() => undefined)
      await announce(await api.get(id)).catch(() => undefined)
    })

  return { sweep }
}
