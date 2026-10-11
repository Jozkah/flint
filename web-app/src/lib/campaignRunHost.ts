import { isLiveTask, isServerDriven, type Campaign } from '@/lib/campaignModel'
import { stalledTaskIds } from '@/hooks/useStalledTasks'

/**
 * Which task sessions need a page mounted to have a live run, regardless of
 * the route (docs/CAMPAIGNS.md, R3). Pure.
 *
 * A session qualifies when its campaign is running here (not server-driven)
 * and its task is live or queued with a session, the session still exists, and
 * no visible page already drives it.
 */
export function sessionsNeedingHost(input: {
  campaigns: readonly Campaign[]
  sessionIds: ReadonlySet<string>
  hostedElsewhere: ReadonlySet<string>
}): string[] {
  const out = new Set<string>()
  for (const c of input.campaigns) {
    if (isServerDriven(c) || c.status !== 'running') continue
    for (const t of c.tasks) {
      const sid = t.sessionId
      if (!sid || !input.sessionIds.has(sid)) continue
      if (!isLiveTask(t.status) && t.status !== 'queued') continue
      if (input.hostedElsewhere.has(sid)) continue
      out.add(sid)
    }
  }
  return [...out]
}

export const RESTART_AFTER_MS = 15_000

/**
 * `running` tasks that have had no run, no recorded ending and nothing queued
 * for longer than the grace, and have not been put back once already in this
 * process. A reload keeps the backend's `running` record without its run and
 * without the resume seed; putting the task back through `interrupted` and
 * `queued` makes the runner seed and start it again. Pure.
 */
export function stalledToRequeue(input: {
  campaigns: readonly Campaign[]
  live: ReadonlySet<string>
  ended: (sid: string) => boolean
  hasReady: (sid: string) => boolean
  firstSeen: Map<string, number>
  already: ReadonlySet<string>
  now: number
  afterMs?: number
}): { campaignId: string; taskId: string }[] {
  const owner = new Map<string, string>()
  const tasks: { id: string; status: string; sessionId?: string | null }[] = []
  for (const c of input.campaigns) {
    if (isServerDriven(c) || c.status !== 'running') continue
    for (const t of c.tasks) {
      if (t.status !== 'running' || !t.sessionId) continue
      if (input.ended(t.sessionId) || input.hasReady(t.sessionId)) continue
      if (input.already.has(t.id)) continue
      owner.set(t.id, c.id)
      tasks.push({ id: t.id, status: t.status, sessionId: t.sessionId })
    }
  }
  return stalledTaskIds(
    tasks,
    input.live,
    input.firstSeen,
    input.now,
    input.afterMs ?? RESTART_AFTER_MS
  ).map((taskId) => ({ campaignId: owner.get(taskId)!, taskId }))
}
