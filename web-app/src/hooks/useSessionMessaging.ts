import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

/**
 * Per-session settings and bookkeeping for cross-session messaging
 * (docs/SESSION_MESSAGING.md).
 *
 * `autoWake` is the only persisted field. The wake tracking is transient: it
 * describes runs of this app process, and a restart ends every run.
 */
type SessionMessagingState = {
  /**
   * "Automatic wake-ups", per session. Absent is off: without it, mail from
   * another session waits for the user and never starts a run on its own.
   */
  autoWake: Record<string, boolean>
  setAutoWake: (sessionId: string, on: boolean) => void
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
      pendingWake: {},
      lastRunWasWake: {},

      setAutoWake: (sessionId, on) =>
        set((s) => ({
          autoWake: on
            ? { ...s.autoWake, [sessionId]: true }
            : omit(s.autoWake, sessionId),
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
          pendingWake: omit(s.pendingWake, sessionId),
          lastRunWasWake: omit(s.lastRunWasWake, sessionId),
        })),
    }),
    {
      name: localStorageKey.sessionMessaging,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (state) => ({ autoWake: state.autoWake }),
    }
  )
)
