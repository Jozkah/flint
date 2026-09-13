/**
 * A Cowork session as one portable file. AH-203.
 *
 * Export assembles the session's turns, subagent runs, questions (carried on
 * the turns), durable tool activity, file activity and change summary into a
 * versioned bundle; the backend drops authority and machine paths, redacts
 * credentials and writes it where the user chose. Import reads it back through
 * the backend, which refuses a schema version it does not understand, and
 * creates a new, unbound session from it here.
 *
 * An imported session is history, not a live run: it gets a fresh id, no
 * folder, no access and no consent, and a question that was still pending
 * when it was exported comes back `stale`, because nothing is waiting for the
 * answer any more.
 */
import { invoke } from '@tauri-apps/api/core'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { CoworkTurn, SubagentRun } from '@/types/coworkSession'
import type { FileActivityEvent } from '@/lib/fileActivity'
import type { ToolActivityItem } from '@/lib/toolActivity'
import { collectCodeFileDiffs } from '@/lib/coworkDiffs'
import { errorText } from '@/lib/errorText'

export const BUNDLE_FORMAT = 'jan.cowork-session'
export const BUNDLE_SCHEMA_VERSION = 1

export type SessionBundle = {
  format: typeof BUNDLE_FORMAT
  schemaVersion: number
  exportId: string
  exportedAt: string
  session: {
    id: string
    title: string
    turns: CoworkTurn[]
    subagents?: SubagentRun[]
    mode?: CoworkSession['mode']
    goal?: CoworkSession['goal']
    todos?: CoworkSession['todos']
    forkedFrom?: CoworkSession['forkedFrom']
    /**
     * The provider's usage for the session's last request, cache breakdown
     * included. Absent from bundles written before AH-211, which import with
     * no usage rather than a zero one.
     */
    lastUsage?: CoworkSession['lastUsage']
    updated: number
  }
  toolActivity: ToolActivityItem[]
  fileActivity: FileActivityEvent[]
  changeSummary: { path: string; additions: number; deletions: number }[]
}

export type ImportedFrom = {
  exportId: string
  sessionId: string
  at: number
}

/** Assemble a bundle. Pure: nothing is read from a store or written. */
export function buildBundle(input: {
  session: CoworkSession
  toolActivity: ToolActivityItem[]
  fileActivity: FileActivityEvent[]
  exportId?: string
  now?: Date
}): SessionBundle {
  const { session } = input
  const summary = collectCodeFileDiffs(session.turns, session.subagents ?? [])
  return {
    format: BUNDLE_FORMAT,
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    exportId: input.exportId ?? crypto.randomUUID(),
    exportedAt: (input.now ?? new Date()).toISOString(),
    // Only what the conversation is. Folder, access, consent, worktree and
    // the code panel describe this machine and this user's grants; the
    // backend drops them again in case a caller passes them anyway.
    session: {
      id: session.id,
      title: session.title,
      turns: session.turns,
      subagents: session.subagents,
      mode: session.mode,
      goal: session.goal,
      todos: session.todos,
      forkedFrom: session.forkedFrom,
      lastUsage: session.lastUsage,
      updated: session.updated,
    },
    toolActivity: input.toolActivity.filter((i) => i.session === session.id),
    fileActivity: input.fileActivity,
    changeSummary: summary.map(({ path, additions, deletions }) => ({
      path,
      additions,
      deletions,
    })),
  }
}

/** Why an import was refused. */
export type ImportRefusal =
  | { reason: 'already-imported'; sessionId: string }
  | { reason: 'invalid'; message: string }

/**
 * Checked again here, not only in the backend: the store must never hold a
 * session built from a document it does not understand.
 */
export function checkBundle(value: unknown): string | null {
  const b = value as Partial<SessionBundle> | null
  if (!b || b.format !== BUNDLE_FORMAT) return 'not a Jan session export'
  if (b.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    return `schema version ${String(b.schemaVersion)} is not one this version of Jan understands`
  }
  if (!b.exportId) return 'the export has no id'
  if (!b.session || !Array.isArray(b.session.turns)) {
    return 'the export carries no conversation'
  }
  return null
}

/** Turns as they come back on this machine: same order, same states. */
export function importedTurns(
  turns: CoworkTurn[],
  sessionId: string
): CoworkTurn[] {
  return turns.map((turn) => {
    if (!turn.asks?.length) return turn
    return {
      ...turn,
      asks: turn.asks.map((ask) => ({
        ...ask,
        sessionId,
        // Nothing is waiting for this answer on this machine.
        state: ask.state === 'pending' ? 'stale' : ask.state,
      })),
    }
  })
}

/** File activity re-keyed to the new session, in its recorded order. */
export function importedFileActivity(
  events: FileActivityEvent[],
  sessionId: string
): FileActivityEvent[] {
  return events.map((event) => {
    const origin = event.origin as unknown
    if (origin && typeof origin === 'object' && 'sessionKey' in origin) {
      return {
        ...event,
        origin: { ...(origin as object), sessionKey: sessionId },
      } as unknown as FileActivityEvent
    }
    return event
  })
}

export type ExportOutcome =
  | { ok: true; path: string; redactions: number }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; message: string }

export async function exportBundle(
  bundle: SessionBundle
): Promise<ExportOutcome> {
  try {
    const report = await invoke<{ path: string; redactions: number } | null>(
      'session_export_save',
      { bundle }
    )
    if (!report) return { ok: false, cancelled: true }
    return { ok: true, path: report.path, redactions: report.redactions }
  } catch (e) {
    return { ok: false, cancelled: false, message: errorText(e) }
  }
}

export type OpenOutcome =
  | { ok: true; bundle: SessionBundle }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; message: string }

export async function openBundle(): Promise<OpenOutcome> {
  try {
    const bundle = await invoke<SessionBundle | null>('session_import_open')
    if (!bundle) return { ok: false, cancelled: true }
    const problem = checkBundle(bundle)
    if (problem) return { ok: false, cancelled: false, message: problem }
    return { ok: true, bundle }
  } catch (e) {
    return { ok: false, cancelled: false, message: errorText(e) }
  }
}
