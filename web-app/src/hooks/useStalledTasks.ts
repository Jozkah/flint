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

const NONE: string[] = []

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
  const last = useRef<string[]>(NONE)
  if (!enabled) return NONE
  const next = stalledTaskIds(
    tasks,
    new Set(Object.keys(runs)),
    seen.current,
    Date.now()
  )
  // The same ids keep the same array, so a consumer that memoizes on it (or
  // lists it in an effect) is not re-run by every 2 s tick.
  const prev = last.current
  if (next.length === prev.length && next.every((id, i) => id === prev[i])) {
    return prev
  }
  last.current = next
  return next
}
