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

export const PRESENCE_DEBOUNCE_MS = 400
export const HEARTBEAT_INTERVAL_MS = 30_000

type PresenceMailbox = Pick<
  SessionMailbox,
  'register' | 'setStatus' | 'heartbeat' | 'remove'
>

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

const registrationKey = (s: CoworkSession) =>
  JSON.stringify([s.title, s.folder ?? null])

export function createPresenceSync(
  mailbox: PresenceMailbox = sessionMailbox,
  opts: { debounceMs?: number; heartbeatMs?: number } = {}
) {
  const debounceMs = opts.debounceMs ?? PRESENCE_DEBOUNCE_MS
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS
  const registered = new Map<string, string>()
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const runs = new Map<string, string>()
  const heartbeats = new Map<string, ReturnType<typeof setInterval>>()

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
      setTimeout(() => {
        pending.delete(session.id)
        const latest = useCoworkSessions
          .getState()
          .sessions.find((s) => s.id === session.id)
        if (!latest) return
        const key = registrationKey(latest)
        if (registered.get(latest.id) === key) return
        registered.set(latest.id, key)
        safe('register', () =>
          mailbox.register({
            sessionId: latest.id,
            displayName: latest.title,
            folder: latest.folder,
          })
        )
      }, debounceMs)
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
      notifySessionRemoved(s.id)
    }
  }

  const stopHeartbeat = (sid: string) => {
    const timer = heartbeats.get(sid)
    if (timer) clearInterval(timer)
    heartbeats.delete(sid)
  }

  const syncRuns = (
    current: Record<string, { runId: string; startedAt: number }>
  ) => {
    for (const [sid, run] of Object.entries(current)) {
      if (runs.get(sid) === run.runId) continue
      runs.set(sid, run.runId)
      stopHeartbeat(sid)
      safe('status', () =>
        mailbox.setStatus({ sessionId: sid, running: true, runId: run.runId })
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
    for (const sid of [...runs.keys()]) {
      if (current[sid]) continue
      runs.delete(sid)
      stopHeartbeat(sid)
      safe('status', () => mailbox.setStatus({ sessionId: sid, running: false }))
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
      if (state.runs !== prev.runs) syncRuns(state.runs)
    })
    return () => {
      offSessions()
      offRuns()
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
    removalMailbox = sessionMailbox
  },
  setRemovalMailbox: (mailbox: PresenceMailbox) => {
    removalMailbox = mailbox
  },
}
