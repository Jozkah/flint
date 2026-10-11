import { useEffect, useRef, useState } from 'react'
import { useCoworkRun } from '@/hooks/useCoworkRun'

/** How long a `running` task may have no live run before the board says so. */
export const STALLED_AFTER_MS = 10_000

type TaskLike = { id: string; status: string; sessionId?: string | null }

/**
 * Ids of tasks the record calls `running` that have had no live run for more
 * than `afterMs`: after a window reload the record outlives the runs, and a
 * run only restarts when its Cowork page is shown. Pure, for tests.
 */
export function stalledTaskIds(
  tasks: readonly TaskLike[],
  live: ReadonlySet<string>,
  firstSeen: Map<string, number>,
  now: number,
  afterMs = STALLED_AFTER_MS
): string[] {
  const out: string[] = []
  const keep = new Set<string>()
  for (const t of tasks) {
    if (t.status !== 'running' || !t.sessionId || live.has(t.sessionId)) continue
    keep.add(t.id)
    const since = firstSeen.get(t.id) ?? now
    firstSeen.set(t.id, since)
    if (now - since > afterMs) out.push(t.id)
  }
  for (const id of [...firstSeen.keys()]) if (!keep.has(id)) firstSeen.delete(id)
  return out
}

/** Re-evaluated every 2 s and whenever the tasks or the live runs change. */
export function useStalledTasks(
  tasks: readonly TaskLike[],
  enabled: boolean
): string[] {
  const runs = useCoworkRun((s) => s.runs)
  const seen = useRef(new Map<string, number>())
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setTick((n) => n + 1), 2_000)
    return () => clearInterval(timer)
  }, [enabled])
  void tick
  if (!enabled) return []
  return stalledTaskIds(
    tasks,
    new Set(Object.keys(runs)),
    seen.current,
    Date.now()
  )
}
