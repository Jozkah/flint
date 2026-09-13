/**
 * Stepping through a finished run, one recorded event at a time. AH-176.
 *
 * The backend decides what a finished run is (`agent_events_runs` /
 * `agent_events_run`): a run that has not ended, a run the log does not hold,
 * or a log that cannot be read is a typed refusal, never an empty replay. This
 * module only loads what it says and computes what the timeline looked like
 * after step N, by building the timeline from the first N events -- the same
 * builder the live panel uses, so a step shows exactly the state the record
 * held at that point, not a re-interpretation of it.
 */
import { invoke } from '@tauri-apps/api/core'
import type { EventEnvelope } from '@/lib/eventLog'
import { buildTimeline, type TimelineRow } from '@/lib/executionTimeline'

export type FinishedRun = {
  run: string
  startedAt: string
  endedAt: string
  stoppedBy: string
  steps: number
  truncated: boolean
}

export type RunRecording = FinishedRun & { events: EventEnvelope[] }

export type ReplayError = { kind: string; message: string }

export type Loaded<T> = { ok: true; value: T } | { ok: false; error: ReplayError }

type Call = (cmd: string, args: Record<string, unknown>) => Promise<unknown>

const typed = (e: unknown): ReplayError =>
  e && typeof e === 'object' && 'kind' in e && 'message' in e
    ? { kind: String((e as ReplayError).kind), message: String((e as ReplayError).message) }
    : { kind: 'internal', message: e instanceof Error ? e.message : String(e) }

/** The session's finished runs, oldest first. Never throws. */
export async function listFinishedRuns(
  session: string,
  call: Call = invoke
): Promise<Loaded<FinishedRun[]>> {
  try {
    return { ok: true, value: (await call('agent_events_runs', { session })) as FinishedRun[] }
  } catch (e) {
    return { ok: false, error: typed(e) }
  }
}

/** One finished run's events, in log order. Never throws. */
export async function loadRunRecording(
  session: string,
  run: string,
  call: Call = invoke
): Promise<Loaded<RunRecording>> {
  try {
    return { ok: true, value: (await call('agent_events_run', { session, run })) as RunRecording }
  } catch (e) {
    return { ok: false, error: typed(e) }
  }
}

/** Clamp a step to the recording: 1 is the first event, `events.length` the last. */
export function clampStep(step: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(Math.max(1, Math.trunc(step)), total)
}

/** The timeline as it stood after `step` events. */
export function rowsAtStep(events: EventEnvelope[], step: number, session: string): TimelineRow[] {
  return buildTimeline(events.slice(0, clampStep(step, events.length)), session)
}

/**
 * The row the event at `step` created or changed: new at this step, or
 * different from what it was one step earlier. `undefined` when the event
 * changed no row (a kind the timeline folds into another row unchanged).
 */
export function rowChangedAt(
  events: EventEnvelope[],
  step: number,
  session: string
): string | undefined {
  const at = clampStep(step, events.length)
  if (at === 0) return undefined
  const before = new Map(
    (at > 1 ? rowsAtStep(events, at - 1, session) : []).map((r) => [r.id, JSON.stringify(r)])
  )
  const now = rowsAtStep(events, at, session)
  for (let i = now.length - 1; i >= 0; i--) {
    if (before.get(now[i].id) !== JSON.stringify(now[i])) return now[i].id
  }
  return undefined
}
