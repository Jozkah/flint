import { redactingSessionStorage } from '@/lib/redactSessionStorage'
import { shardedSessionStorage } from '@/lib/shardedSessionStorage'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import { deferredPersistStorage } from '@/lib/deferredPersistStorage'
import {
  decideSessionStart,
  DEFAULT_SESSION_TITLE,
  isSessionEmpty,
  pruneEmptySessions,
} from '@/lib/coworkSessionStart'
import { useFileActivity } from '@/hooks/useFileActivity'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import type { CoworkSession, CoworkSessionsState } from '@/hooks/coworkSessions/types'
import { createLifecycleSlice } from '@/hooks/coworkSessions/lifecycleSlice'
import { createSessionUpdatesSlice } from '@/hooks/coworkSessions/updatesSlice'
import { createTurnsSlice } from '@/hooks/coworkSessions/turnsSlice'
import {
  migrateCoworkSessions,
  sessionForDisk,
} from '@/hooks/coworkSessions/persistence'

// The transcript/todo/subagent shapes live in a store-free module so panels and
// pure helpers can import them without pulling in zustand. Re-exported here
// because this store is still their most natural import site.
export type {
  CoworkTurn,
  Usage,
  SubagentRun,
  TodoStatus,
  TodoItem,
  TodoPhase,
  TodoList,
  CoworkGoal,
} from '@/types/coworkSession'

export type {
  CoworkMessage,
  TodoSnapshot,
  ProgressUi,
  CoworkSession,
  PendingInputRecord,
  ForkOrigin,
  RunBudgetRecord,
} from '@/hooks/coworkSessions/types'
export { recordTodoSnapshot } from '@/hooks/coworkSessions/updatesSlice'

export const useCoworkSessions = create<CoworkSessionsState>()(
  persist(
    (...a) => ({
      sessions: [],
      currentId: null,
      ...createLifecycleSlice(...a),
      ...createSessionUpdatesSlice(...a),
      ...createTurnsSlice(...a),
    }),
    {
      name: localStorageKey.coworkSessions,
      // Persist through the Rust settings store (see backendStorage) so sessions
      // live in <jan_data>/settings.json instead of webview localStorage.
      // Async storage requires skipHydration + explicit rehydrate in
      // hydrateBackendStores() once the ServiceHub is ready.
      // Tool arguments and results are redacted on their way to disk only; the
      // live history the model reads stays raw.
      // Written off the click path: see deferredPersistStorage.
      storage: deferredPersistStorage(
        // One key per session: a flush writes only the sessions that changed.
        shardedSessionStorage(
          redactingSessionStorage(backendStorage)
        ),
        1500,
        {
          // Quiet app: write within a moment so a close loses nothing; a
          // streaming run keeps the long delay so it costs one write.
          idleDelay: 250,
          busy: () => Object.keys(useCoworkRun.getState().runs ?? {}).length > 0,
        }
      ),
      skipHydration: true,
      // Images a tool returned (a `read` of a png) are in the live history for
      // the model to see; the saved session keeps only the text of the result.
      partialize: (state) => ({
        ...state,
        sessions: state.sessions.map(sessionForDisk),
      }),
      // Blank sessions left over from earlier launches are dropped as the
      // store loads, except the one that is selected.
      merge: (persisted, current) => {
        const merged = {
          ...current,
          ...(persisted as Partial<CoworkSessionsState> | undefined),
        }
        return {
          ...merged,
          sessions: pruneEmptySessions(merged.sessions ?? [], merged.currentId ?? null),
        }
      },
      version: 5,
      migrate: migrateCoworkSessions,
    }
  )
)

/**
 * Return the current session, creating one if none is selected.
 *
 * `paneSessionId` is the session of the split-view pane asking: a pane acts
 * on its own session, never on the global selection (which belongs to the
 * main pane), so when it names a session that exists, that one is returned.
 */
export function ensureCurrentSession(paneSessionId?: string | null): string {
  const { currentId, sessions, createSession } = useCoworkSessions.getState()
  if (paneSessionId && sessions.some((s) => s.id === paneSessionId))
    return paneSessionId
  if (currentId && sessions.some((s) => s.id === currentId)) return currentId
  // The selection points nowhere. A blank session already in the list is the
  // new one; creating another each time is how blanks accumulated.
  const blank = sessions.find(
    (s) =>
      isSessionEmpty(s) &&
      s.title === DEFAULT_SESSION_TITLE &&
      useFileActivity.getState().eventsFor(s.id).length === 0
  )
  if (blank) {
    useCoworkSessions.getState().selectSession(blank.id)
    return blank.id
  }
  return createSession()
}

/**
 * "New session" from a split-view pane beside the main one.
 *
 * Judged on the pane's own session, the same way startSession judges the
 * current one, and the global selection is left alone: it belongs to the main
 * pane. A new session is added without dropping any blank one, since the main
 * pane may be showing it.
 */
export function startPaneSession(
  paneSessionId: string,
  input: { running: boolean; draft?: string }
): string {
  return startPaneSessionParked(paneSessionId, input).id
}

/** `startPaneSession`, also reporting whether the draft was parked. */
export function startPaneSessionParked(
  paneSessionId: string,
  input: { running: boolean; draft?: string }
): { id: string; parked: boolean } {
  const state = useCoworkSessions.getState()
  const current = state.sessions.find((s) => s.id === paneSessionId)
  const hasFileActivity = current
    ? useFileActivity.getState().eventsFor(current.id).length > 0
    : false
  if (
    current &&
    decideSessionStart({
      current,
      running: input.running,
      hasFileActivity,
    }) === 'reuse'
  ) {
    return { id: current.id, parked: false }
  }
  const parked = Boolean(current && input.draft?.trim())
  if (current && parked) {
    state.setPendingInput(current.id, [
      ...(current.pendingInput ?? []),
      { id: crypto.randomUUID(), text: input.draft as string, createdAt: Date.now() },
    ])
  }
  const id = crypto.randomUUID()
  const session: CoworkSession = {
    id,
    title: DEFAULT_SESSION_TITLE,
    folder: null,
    turns: [],
    messages: [],
    updated: Date.now(),
    createdAt: Date.now(),
  }
  useCoworkSessions.setState((s) => ({ sessions: [session, ...s.sessions] }))
  return { id, parked }
}
