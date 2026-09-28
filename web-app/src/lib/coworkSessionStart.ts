/**
 * What "New session" should do.
 *
 * Pressing it on a session that has nothing in it used to create a second
 * empty session, then a third — a list of blanks the user never asked for.
 * The decision is separated from the store so the rules can be read, and
 * tested, without a session store or a router.
 */

import type { CoworkSession } from '@/hooks/useCoworkSessions'

export type SessionStartDecision =
  /** Stay where we are: this session is already the new one. */
  | 'reuse'
  /** The current session has something in it; start a fresh one. */
  | 'create'

/**
 * Has anything happened in this session?
 *
 * Emptiness is judged on what was *persisted* — the transcript the user can
 * see and the messages the model was sent — plus the files they opened, which
 * is work even though no turn ran. A title is not activity: every session
 * starts with the same one.
 */
export function isSessionEmpty(session: CoworkSession | undefined): boolean {
  if (!session) return true
  if (session.turns.length > 0) return false
  if (session.messages.length > 0) return false
  if (session.todos?.phases?.length) return false
  // Tabs the user opened are work in the session, even with no turn run.
  if (session.codePanel?.tabs?.length) return false
  // So is an attached project. Reusing that session as the "new" one kept the
  // previous project attached to it, which is exactly what a new session is
  // supposed to leave behind.
  if (session.folder) return false
  return true
}

export type SessionStartInput = {
  current: CoworkSession | undefined
  /** A run is in flight. Work in progress is content, even before it lands. */
  running: boolean
  /**
   * Unsent composer text, or attachments waiting to be sent.
   *
   * Reported, not a veto: the store parks the draft on the session it was
   * typed in (held input, janhq/jan#8864) and starts the new one blank.
   * The decision itself no longer reads it.
   */
  hasDraft: boolean
  /**
   * The session already has recorded file activity.
   *
   * Activity is recorded per settled operation, as a run proceeds, while turns
   * only reach the session when the run commits. So a run that was cancelled,
   * failed, or was cut short by a restart leaves a session whose transcript is
   * empty but which has already touched files. Reusing that as the "new"
   * session would carry the old work's history into it.
   */
  hasFileActivity: boolean
}

/**
 * Whether to create a session or stay on this one.
 *
 * A draft no longer blocks the press: it is parked on the session it was
 * typed in as held input, shown there with Send and Discard, and the new
 * session opens with a blank composer. Blocking used to leave the press a
 * silent no-op, which read as a dead button.
 */
export function decideSessionStart(input: SessionStartInput): SessionStartDecision {
  if (!input.current) return 'create'
  if (input.running) return 'create'
  if (input.hasFileActivity) return 'create'
  return isSessionEmpty(input.current) ? 'reuse' : 'create'
}

/**
 * Drop the blank sessions that piled up, keeping the one the user is on.
 *
 * Every path that needed "a session" used to create one when the selection
 * pointed nowhere, and each was persisted at once, so the list filled with
 * "New session" entries nobody wrote in. A blank session holds nothing to
 * lose. One the user renamed is kept: the name is something they put there.
 */
export function pruneEmptySessions(
  sessions: CoworkSession[],
  keepId: string | null
): CoworkSession[] {
  const pruned = sessions.filter(
    (session) =>
      session.id === keepId ||
      !isSessionEmpty(session) ||
      session.title !== DEFAULT_SESSION_TITLE
  )
  return pruned.length === sessions.length ? sessions : pruned
}

/** The title every session starts with. */
export const DEFAULT_SESSION_TITLE = 'New session'
