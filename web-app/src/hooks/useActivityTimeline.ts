import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  appendActivityEvent,
  cancelInFlight,
  emptyActivityLog,
  patchActivityEvent,
  type ActivityEvent,
  type ActivityLog,
  type IncomingActivityEvent,
} from '@/lib/activityEvents'

/**
 * The one store every surface that reports on a run reads (AH-201).
 *
 * The inline timeline in the conversation, the activity rail, the Background
 * Tasks panel and the audit export all select from here, so they cannot disagree
 * about the same run. The reducers live in `activityEvents.ts`; this adds only
 * persistence and the session-scoped actions the run driver calls -- the same
 * split as `useCoworkActivity`, for the same reason: the rules stay testable
 * without React, zustand or a running agent.
 *
 * Persisted, because the timeline is the record of what happened and a reload
 * must not erase it. What cannot survive a restart is a *running* row: the
 * command's process and the subagent's stream both died with the process that
 * owned them, so `recoverOnLoad` settles anything the previous app run left in
 * flight rather than leaving rows spinning forever.
 *
 * Logs are keyed by session and nothing here reaches across them. A session's
 * log is created on first write and dropped with the session.
 */
type ActivityTimelineState = {
  /** One append-only log per session. */
  logs: Record<string, ActivityLog>

  /** Record an event. Creates the session's log if this is its first. */
  record: (event: IncomingActivityEvent) => void
  /** Record several in one update, so a batch is one render. */
  recordMany: (events: IncomingActivityEvent[]) => void
  /** Merge a patch onto one event of a session. */
  patch: (
    sessionId: string,
    id: string,
    patch: Partial<Omit<ActivityEvent, 'id' | 'seq' | 'sessionId' | 'at'>>
  ) => void
  /** Mark a session's in-flight rows cancelled and record the stop. */
  cancelSession: (sessionId: string, reason?: string) => void
  /** Forget a session's timeline entirely, for a deleted session. */
  dropSession: (sessionId: string) => void
  /** Settle rows the previous app run left in flight. */
  recoverOnLoad: (reason: string) => void
}

const now = () => Date.now()

/** The log for `sessionId`, created empty if it does not exist yet. */
function logFor(
  logs: Record<string, ActivityLog>,
  sessionId: string
): ActivityLog {
  return logs[sessionId] ?? emptyActivityLog(sessionId)
}

export const useActivityTimeline = create<ActivityTimelineState>()(
  persist(
    (set) => ({
      logs: {},

      record: (event) =>
        set((state) => ({
          logs: {
            ...state.logs,
            [event.sessionId]: appendActivityEvent(
              logFor(state.logs, event.sessionId),
              event
            ),
          },
        })),

      recordMany: (events) =>
        set((state) => {
          if (events.length === 0) return state
          const logs = { ...state.logs }
          for (const event of events) {
            logs[event.sessionId] = appendActivityEvent(
              logFor(logs, event.sessionId),
              event
            )
          }
          return { logs }
        }),

      patch: (sessionId, id, patch) =>
        set((state) => {
          const log = state.logs[sessionId]
          // No log means no row to patch. Creating one here would produce an
          // event with no beginning, which is worse than a lost update.
          if (!log) return state
          return { logs: { ...state.logs, [sessionId]: patchActivityEvent(log, id, patch) } }
        }),

      cancelSession: (sessionId, reason) =>
        set((state) => {
          const log = state.logs[sessionId]
          if (!log) return state
          return {
            logs: { ...state.logs, [sessionId]: cancelInFlight(log, now(), reason) },
          }
        }),

      dropSession: (sessionId) =>
        set((state) => {
          if (!state.logs[sessionId]) return state
          const logs = { ...state.logs }
          delete logs[sessionId]
          return { logs }
        }),

      recoverOnLoad: (reason) =>
        set((state) => {
          const at = now()
          let touched = false
          const logs: Record<string, ActivityLog> = {}
          for (const [sessionId, log] of Object.entries(state.logs)) {
            const pending = log.events.some((event) => event.status === 'pending')
            if (!pending) {
              logs[sessionId] = log
              continue
            }
            touched = true
            logs[sessionId] = cancelInFlight(log, at, reason)
          }
          return touched ? { logs } : state
        }),
    }),
    {
      name: localStorageKey.activityTimeline,
      // Through the Rust settings store, like the sessions and the background
      // activity record, so the timeline lives in <jan_data>/settings.json
      // rather than webview localStorage. Async storage requires skipHydration
      // plus an explicit rehydrate in hydrateBackendStores().
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      version: 1,
      // Only the record is persisted; the actions are rebuilt on load.
      partialize: (state) => ({ logs: state.logs }),
    }
  )
)

/** The log for a session, or an empty one. Stable enough to select on. */
export function selectActivityLog(
  state: ActivityTimelineState,
  sessionId: string | undefined
): ActivityLog {
  if (!sessionId) return EMPTY_LOG
  return state.logs[sessionId] ?? EMPTY_LOG
}

/**
 * One shared empty log, so a selector for a session with no events returns the
 * same object every time and does not re-render its subscriber on every store
 * change.
 */
const EMPTY_LOG: ActivityLog = Object.freeze(emptyActivityLog(''))
