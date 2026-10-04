import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

/**
 * Per-session settings and bookkeeping for cross-session messaging
 * (docs/SESSION_MESSAGING.md).
 *
 * `autoWake` and `optOut` are the persisted fields. The wake tracking is
 * transient: it describes runs of this app process, and a restart ends every
 * run.
 */
type SessionMessagingState = {
  /**
   * "Automatic wake-ups", per session. Absent is on: mail from another session
   * is handed to this session's agent as soon as the session is idle, shown as
   * a message from its sender, so that "ask the other chat" works while the
   * user is elsewhere. An explicit `false` is off: the mail then waits for the
   * user and never starts a run on its own. Approvals are unaffected either
   * way -- a message is untrusted text, never a grant.
   */
  autoWake: Record<string, boolean>
  setAutoWake: (sessionId: string, on: boolean) => void
  /**
   * Sessions that refuse messages from other sessions. Absent accepts: a
   * session is reachable until its user says otherwise.
   */
  optOut: Record<string, boolean>
  setAcceptsMessages: (sessionId: string, accepts: boolean) => void
  /** An automatic wake-up released mail that the session's next run will take. */
  pendingWake: Record<string, boolean>
  /** Whether the session's current or last run was started by a wake-up. */
  lastRunWasWake: Record<string, boolean>
  markWakeRequested: (sessionId: string) => void
  /** Called when a run starts: it was a wake-up if one was requested. */
  noteRunStarted: (sessionId: string) => void
  forget: (sessionId: string) => void
}

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

export const useSessionMessaging = create<SessionMessagingState>()(
  persist(
    (set) => ({
      autoWake: {},
      optOut: {},
      pendingWake: {},
      lastRunWasWake: {},

      setAutoWake: (sessionId, on) =>
        set((s) => ({
          autoWake: on
            ? omit(s.autoWake, sessionId)
            : { ...s.autoWake, [sessionId]: false },
        })),

      setAcceptsMessages: (sessionId, accepts) =>
        set((s) => ({
          optOut: accepts
            ? omit(s.optOut, sessionId)
            : { ...s.optOut, [sessionId]: true },
        })),

      markWakeRequested: (sessionId) =>
        set((s) => ({ pendingWake: { ...s.pendingWake, [sessionId]: true } })),

      noteRunStarted: (sessionId) =>
        set((s) => ({
          lastRunWasWake: {
            ...s.lastRunWasWake,
            [sessionId]: s.pendingWake[sessionId] === true,
          },
          pendingWake: omit(s.pendingWake, sessionId),
        })),

      forget: (sessionId) =>
        set((s) => ({
          autoWake: omit(s.autoWake, sessionId),
          optOut: omit(s.optOut, sessionId),
          pendingWake: omit(s.pendingWake, sessionId),
          lastRunWasWake: omit(s.lastRunWasWake, sessionId),
        })),
    }),
    {
      name: localStorageKey.sessionMessaging,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (state) => ({
        autoWake: state.autoWake,
        optOut: state.optOut,
      }),
    }
  )
)
