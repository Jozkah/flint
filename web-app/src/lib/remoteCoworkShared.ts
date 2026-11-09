// What the server-session bridge (remoteCowork.ts) and its run mirror
// (remoteRun.ts) share: the dependency seam, titles, committing a
// transcript, and the runs being followed. Apart from both so neither
// imports the other.

import type { RunEnding } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { coworkTurnsToUIMessages } from '@/lib/coworkTurns'
import { getRemoteSession } from '@/lib/remoteRunner'
import type { CoworkTurn, Usage } from '@/types/coworkSession'
import { DEFAULT_SESSION_TITLE } from '@/lib/coworkSessionStart'
import type { RemoteRun } from '@/lib/remoteRun'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** What a test (or a caller with its own transport) can replace. */
export type RemoteDeps = {
  fetchImpl?: FetchLike
  /** Milliseconds between looks at the composer's steering queue. */
  steerEveryMs?: number
}

/** How a finished remote turn is shown, in the vocabulary the route uses. */
export function endingFor(payload: Record<string, unknown>): RunEnding | null {
  const reason = String(payload.stopReason ?? '')
  const error = typeof payload.error === 'string' ? payload.error : ''
  if (reason === 'interrupted') return { stoppedBy: 'aborted' }
  if (reason === 'error' || error) return { stoppedBy: 'error', errorText: error || 'The server run failed.' }
  return null
}
/** The server's title, unless it is only the session id (an unnamed session). */
export function titleOf(row: { id: string; title?: string | null }): string {
  return row.title && row.title.trim() && row.title !== row.id ? row.title : ''
}

const TITLE_MAX = 60
/** Titles a server session carries before it has a real one. */
const PLACEHOLDER_TITLES = new Set([DEFAULT_SESSION_TITLE, 'Server session'])

/**
 * A readable title for a server session: the server's own, else the first
 * thing the user said (as a desktop session is titled), else "New session".
 * Never the bare session id the server reports for an unnamed session.
 */
export function remoteSessionTitle(
  id: string,
  title: string | null | undefined,
  turns: ReadonlyArray<{ role: string; content: unknown }> = []
): string {
  const named = titleOf({ id, title })
  if (named) return named
  const first = turns.find(
    (t) => t.role === 'user' && typeof t.content === 'string' && t.content.trim()
  )
  if (first) {
    const line = String(first.content).trim().split(/\r?\n/)[0].trim()
    return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line
  }
  return DEFAULT_SESSION_TITLE
}
/** Replace a remote session's transcript with the server's. */
export async function loadRemoteTranscript(sid: string, fetchImpl?: FetchLike): Promise<void> {
  const got = await getRemoteSession(sid, fetchImpl)
  const turns = (got.turns ?? []) as unknown as CoworkTurn[]
  commitTurns(sid, turns, { title: got.title, folder: got.folder })
}

export function commitTurns(
  sid: string,
  turns: CoworkTurn[],
  extra: { title?: string; folder?: string | null; usage?: Usage } = {}
): void {
  useCoworkSessions.setState((s) => ({
    sessions: s.sessions.map((x) =>
      x.id === sid
        ? {
            ...x,
            turns,
            messages: coworkTurnsToUIMessages(turns, sid),
            updated: Date.now(),
            ...titleUpdate(x, extra.title, turns),
            ...(extra.folder !== undefined ? { folder: extra.folder } : {}),
            ...(extra.usage ? { lastUsage: extra.usage } : {}),
          }
        : x
    ),
  }))
}

/**
 * The title to store with a committed transcript: the server's when it named
 * the session, else one derived from the first message while the row still
 * carries a placeholder (or the bare id). A title already readable is kept.
 */
export function titleUpdate(
  x: { id: string; title: string },
  given: string | undefined,
  turns: CoworkTurn[]
): { title?: string } {
  const named = given ? titleOf({ id: x.id, title: given }) : ''
  if (named) return { title: named }
  if (x.title && x.title !== x.id && !PLACEHOLDER_TITLES.has(x.title)) return {}
  const derived = remoteSessionTitle(x.id, null, turns as Array<{ role: string; content: unknown }>)
  return derived === x.title ? {} : { title: derived }
}

/** The server turns this page is following, by session. */
export const live = new Map<string, RemoteRun>()
