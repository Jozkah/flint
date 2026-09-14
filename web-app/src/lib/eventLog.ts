/**
 * The session's canonical event log, from the renderer's side. AH-005/AH-177.
 *
 * The backend (`event_log`) owns the envelope: it assigns the order, redacts
 * and bounds every payload, and treats a repeated id as one event. The
 * renderer records only what it alone knows -- a run starting and ending, an
 * agent dispatched, a background job -- and never blocks a run on it: a
 * failed record is logged, not thrown. Tool phases reach the log through the
 * tool-activity record the backend already receives.
 *
 * Exports are written under Flint's data folder and never sent anywhere.
 */
import { invoke } from '@tauri-apps/api/core'
import { errorText } from '@/lib/errorText'

export type RunEvent = {
  id: string
  session: string
  run: string
  /** The model request this belongs to, when there is one. */
  invocation?: string
  kind:
    | 'run.started'
    | 'run.ended'
    | 'agent.dispatched'
    | 'agent.ended'
    | 'job.started'
    | 'job.ended'
    | 'usage.reported'
    | 'message.completed'
  payload?: Record<string, unknown>
}

/**
 * Records go out one after another, in the order they were made: the backend
 * numbers them as they arrive, and two concurrent invokes could otherwise
 * land a step's response after the run's end.
 */
let queue: Promise<unknown> = Promise.resolve()

export function recordEvents(events: RunEvent[]): Promise<void> {
  if (events.length === 0) return queue as Promise<void>
  const write = () =>
    invoke('agent_events_record', {
      events: events.map((e) => ({
        id: e.id,
        session: e.session,
        run: e.run,
        invocation: e.invocation ?? '',
        kind: e.kind,
        payload: e.payload ?? {},
      })),
    }).catch((e) => console.warn('event log: could not record', errorText(e)))
  queue = queue.then(write, write)
  return queue as Promise<void>
}

/** One envelope of the session's canonical log (`event_log::Envelope`). */
export type EventEnvelope = {
  v: number
  id: string
  session: string
  run: string
  invocation: string
  seq: number
  at: string
  kind: string
  payload: Record<string, unknown>
  redactions: string[]
}

export type EventsPage = {
  events: EventEnvelope[]
  lastSeq: number
  truncated: boolean
}

/**
 * A session's events after `afterSeq`. Throws the backend's message when the
 * log cannot be read, so the timeline can say so rather than look empty.
 */
export async function listEvents(
  session: string,
  afterSeq = 0,
  limit?: number
): Promise<EventsPage> {
  return await invoke<EventsPage>('agent_events_list', {
    session,
    afterSeq,
    limit: limit ?? null,
  })
}

export type ExportErrorKind =
  | 'no-events'
  | 'too-large'
  | 'cancelled'
  | 'log-unreadable'
  | 'not-an-export'
  | 'unsupported-version'
  | 'manifest-invalid'
  | 'hash-mismatch'
  | 'truncated'
  | 'cross-session'
  | 'out-of-order'
  | 'io'

export type EventExportManifest = {
  schemaVersion: number
  kind: string
  envelopeVersion: number
  session: string
  run: string | null
  metadataOnly: boolean
  count: number
  firstSeq: number
  lastSeq: number
  eventsSha256: string
  createdAt: string
  note: string
}

type Failure = { ok: false; kind: ExportErrorKind; message: string }

const failureOf = (e: unknown): Failure => {
  const f = (e ?? {}) as { kind?: ExportErrorKind; message?: unknown }
  return {
    ok: false,
    kind: f.kind ?? 'io',
    message: typeof f.message === 'string' ? f.message : errorText(e),
  }
}

export const newExportToken = () =>
  `x-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export async function exportEvents(input: {
  token: string
  session: string
  run?: string | null
  includeContent: boolean
}): Promise<{ ok: true; path: string; manifest: EventExportManifest } | Failure> {
  try {
    const report = await invoke<{ path: string; manifest: EventExportManifest }>(
      'agent_events_export',
      {
        token: input.token,
        session: input.session,
        run: input.run ?? null,
        includeContent: input.includeContent,
      }
    )
    return { ok: true, ...report }
  } catch (e) {
    return failureOf(e)
  }
}

export async function cancelEventExport(token: string): Promise<void> {
  await invoke('agent_events_export_cancel', { token }).catch(() => {})
}

export type InspectReport = {
  manifest: EventExportManifest
  kinds: Record<string, number>
  unknownKinds: number
}

export async function inspectEventExport(
  path: string
): Promise<({ ok: true } & InspectReport) | Failure> {
  try {
    return { ok: true, ...(await invoke<InspectReport>('agent_events_inspect', { path })) }
  } catch (e) {
    return failureOf(e)
  }
}
