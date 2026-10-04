/**
 * Keeps the backend mailbox registry in step with Cowork sessions and runs
 * (docs/SESSION_MESSAGING.md, "Identity and presence").
 *
 * Registration follows the session list (create, rename, folder change),
 * removal follows deletion, and status follows the run store: running with a
 * heartbeat while a run is in flight, idle once it ends. Every backend call is
 * best-effort -- a failure is logged and the next change tries again -- so
 * presence can never break the UI that caused it.
 */
import { sessionMailbox, type SessionMailbox } from '@/lib/sessionMailbox'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useSessionMessaging } from '@/hooks/useSessionMessaging'
import {
  selectPendingApprovalCount,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'

export const PRESENCE_DEBOUNCE_MS = 400
export const HEARTBEAT_INTERVAL_MS = 30_000

type PresenceMailbox = Pick<
  SessionMailbox,
  'register' | 'setStatus' | 'heartbeat' | 'remove' | 'revive'
> &
  Partial<Pick<SessionMailbox, 'setWaiting'>>

function safe(label: string, fn: () => Promise<unknown>): void {
  try {
    void fn().catch((e) => console.warn(`[mailbox] ${label} failed:`, e))
  } catch (e) {
    console.warn(`[mailbox] ${label} failed:`, e)
  }
}

const removedSessions = new Set<string>()
let removalMailbox: PresenceMailbox = sessionMailbox

/**
 * Mark a session deleted in the mailbox. Called from the delete path and from
 * the session-list subscription; whichever is first does it, once.
 */
export function notifySessionRemoved(sessionId: string): void {
  if (removedSessions.has(sessionId)) return
  removedSessions.add(sessionId)
  safe('remove', () => removalMailbox.remove(sessionId))
}

const archivedSessions = new Set<string>()

/**
 * The session is leaving the list because it was archived, not deleted. The
 * backend tombstone for a deleted id can never be registered again, so an
 * archived session must not get one or a restore could not register it.
 */
export function notifySessionArchived(sessionId: string): void {
  if (!removedSessions.has(sessionId)) archivedSessions.add(sessionId)
}

/** The session is back in the list (a restore): forget any removal state. */
export function notifySessionRestored(sessionId: string): void {
  archivedSessions.delete(sessionId)
  removedSessions.delete(sessionId)
}

const acceptsMessages = (sessionId: string) =>
  useSessionMessaging.getState().optOut[sessionId] !== true

const registrationKey = (s: CoworkSession) =>
  JSON.stringify([s.title, s.folder ?? null, acceptsMessages(s.id)])

export function createPresenceSync(
  mailbox: PresenceMailbox = sessionMailbox,
  opts: { debounceMs?: number; heartbeatMs?: number } = {}
) {
  const debounceMs = opts.debounceMs ?? PRESENCE_DEBOUNCE_MS
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS
  const registered = new Map<string, string>()
  // Sessions already revived this run: one try each, so a refusal cannot loop.
  const revived = new Set<string>()
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const runs = new Map<string, string>()
  // Sessions last reported as stopped on an approval prompt.
  const waiting = new Set<string>()
  const heartbeats = new Map<string, ReturnType<typeof setInterval>>()

  /**
   * Registrations in flight or done this run. A run's first status call has to
   * come after its session's registration: the backend refuses a status for a
   * session it has not heard of ("this session is not registered"), which left
   * a session that started working straight after being created showing as
   * idle -- and mail for it waiting for a user instead of reaching its run.
   */
  const registrations = new Map<string, Promise<unknown>>()

  const registerNow = (sessionId: string) => {
    const timer = pending.get(sessionId)
    if (timer) clearTimeout(timer)
    pending.delete(sessionId)
    const latest = useCoworkSessions
      .getState()
      .sessions.find((s) => s.id === sessionId)
    if (!latest) return
    const key = registrationKey(latest)
    if (registered.get(latest.id) === key) return
    registered.set(latest.id, key)
    const input = {
      sessionId: latest.id,
      displayName: latest.title,
      folder: latest.folder,
      acceptsMessages: acceptsMessages(latest.id),
    }
    // Called synchronously (an async wrapper runs to its first await), so a
    // backend that throws instead of rejecting still becomes a rejection.
    const done = (async () => mailbox.register(input))().catch((e) => {
      // A tombstone left by a build that marked archived sessions deleted. The
      // session is live in the store, so the tombstone is stale: clear it once
      // and register again. A session the user really deleted is not in the
      // store and is never registered.
      const code = (e as { code?: string } | null)?.code
      const live = useCoworkSessions
        .getState()
        .sessions.some((s) => s.id === input.sessionId)
      if (code !== 'session_deleted' || !live || revived.has(input.sessionId)) {
        throw e
      }
      revived.add(input.sessionId)
      return mailbox.revive(input)
    })
    registrations.set(sessionId, done)
    const settle = () => {
      if (registrations.get(sessionId) === done) registrations.delete(sessionId)
    }
    done.then(settle, settle)
    safe('register', () => done)
  }

  /**
   * Runs `then` once this session's registration (if one is due or in flight)
   * has landed; at once when there is none, which is the usual case.
   */
  const afterRegistration = (sessionId: string, then: () => Promise<unknown>) => {
    if (pending.has(sessionId)) registerNow(sessionId)
    const registration = registrations.get(sessionId)
    return registration ? registration.then(then, then) : then()
  }

  const scheduleRegister = (session: CoworkSession) => {
    if (registered.get(session.id) === registrationKey(session)) {
      const timer = pending.get(session.id)
      if (timer) {
        clearTimeout(timer)
        pending.delete(session.id)
      }
      return
    }
    const existing = pending.get(session.id)
    if (existing) clearTimeout(existing)
    pending.set(
      session.id,
      setTimeout(() => registerNow(session.id), debounceMs)
    )
  }

  const syncSessions = (
    sessions: CoworkSession[],
    previous: CoworkSession[]
  ) => {
    for (const s of sessions) scheduleRegister(s)
    const live = new Set(sessions.map((s) => s.id))
    for (const s of previous) {
      if (live.has(s.id)) continue
      const timer = pending.get(s.id)
      if (timer) clearTimeout(timer)
      pending.delete(s.id)
      registered.delete(s.id)
      // Archived, not deleted: no tombstone (see notifySessionArchived).
      if (archivedSessions.delete(s.id)) continue
      notifySessionRemoved(s.id)
    }
  }

  const stopHeartbeat = (sid: string) => {
    const timer = heartbeats.get(sid)
    if (timer) clearInterval(timer)
    heartbeats.delete(sid)
  }

  /** Report each running session's approval wait, only when it changes. */
  const syncWaiting = () => {
    const approvals = useToolApprovalRequests.getState()
    for (const [sid, runId] of runs.entries()) {
      const now = selectPendingApprovalCount(approvals, sid) > 0
      if (now === waiting.has(sid)) continue
      if (now) waiting.add(sid)
      else waiting.delete(sid)
      const setWaiting = mailbox.setWaiting
      if (!setWaiting) continue
      safe('waiting', () =>
        afterRegistration(sid, () =>
          setWaiting({ sessionId: sid, runId, waiting: now })
        )
      )
    }
  }

  const syncRuns = (
    current: Record<string, { runId: string; startedAt: number }>
  ) => {
    for (const [sid, run] of Object.entries(current)) {
      const previousRun = runs.get(sid)
      if (previousRun === run.runId) continue
      // Replaced without an idle in between: end the old run by its own id
      // first, so the record never names a run that is gone.
      if (previousRun) {
        safe('status', () =>
          afterRegistration(sid, () =>
            mailbox.setStatus({ sessionId: sid, running: false, runId: previousRun })
          )
        )
      }
      runs.set(sid, run.runId)
      waiting.delete(sid)
      stopHeartbeat(sid)
      safe('status', () =>
        afterRegistration(sid, () =>
          mailbox.setStatus({ sessionId: sid, running: true, runId: run.runId })
        )
      )
      heartbeats.set(
        sid,
        setInterval(() => {
          safe('heartbeat', () =>
            mailbox.heartbeat({ sessionId: sid, runId: run.runId })
          )
        }, heartbeatMs)
      )
    }
    for (const [sid, runId] of [...runs.entries()]) {
      if (current[sid]) continue
      runs.delete(sid)
      waiting.delete(sid)
      stopHeartbeat(sid)
      // The run id it started with: the backend ignores an ending that names
      // any other run, so a late ending cannot idle a newer run.
      safe('status', () =>
        afterRegistration(sid, () =>
          mailbox.setStatus({ sessionId: sid, running: false, runId })
        )
      )
    }
  }

  const start = () => {
    removalMailbox = mailbox
    syncSessions(useCoworkSessions.getState().sessions, [])
    syncRuns(useCoworkRun.getState().runs)
    const offSessions = useCoworkSessions.subscribe((state, prev) => {
      if (state.sessions !== prev.sessions) {
        syncSessions(state.sessions, prev.sessions)
      }
    })
    const offRuns = useCoworkRun.subscribe((state, prev) => {
      if (state.runs !== prev.runs) {
        syncRuns(state.runs)
        syncWaiting()
      }
    })
    const offApprovals = useToolApprovalRequests.subscribe((state, prev) => {
      if (state.pending !== prev.pending || state.queued !== prev.queued) {
        syncWaiting()
      }
    })
    // Turning the opt-out on or off is registered at once, not after the
    // debounce: the setting is a promise about who may write to this session.
    const offOptOut = useSessionMessaging.subscribe((state, prev) => {
      if (state.optOut === prev.optOut) return
      for (const s of useCoworkSessions.getState().sessions) {
        if ((state.optOut[s.id] === true) !== (prev.optOut[s.id] === true)) {
          registerNow(s.id)
        }
      }
    })
    return () => {
      offSessions()
      offRuns()
      offApprovals()
      offOptOut()
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      for (const sid of [...heartbeats.keys()]) stopHeartbeat(sid)
    }
  }

  return { start }
}

export const __presenceTesting = {
  reset: () => {
    removedSessions.clear()
    archivedSessions.clear()
    removalMailbox = sessionMailbox
  },
  setRemovalMailbox: (mailbox: PresenceMailbox) => {
    removalMailbox = mailbox
  },
}
