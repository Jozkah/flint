import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  dismissBackground,
  dismissFinished,
  emptyActivityState,
  endWorkflow,
  forgetSession,
  observePhase,
  settleOnLoad,
  settleRunOrphans,
  settleSessionWork,
  startTask,
  startWorkflow,
  updateTask,
  taskIdFor,
  type ActivityState,
  type ActivityTask,
  type ActivityWorkflow,
} from '@/lib/coworkActivity'

/**
 * The one store every background-activity surface reads.
 *
 * The panel, the inline conversation card and the activity chip all select
 * from here, so they cannot disagree about the same run. The reducers live in
 * `coworkActivity.ts`; this adds only persistence and the session-scoped
 * actions the run driver calls.
 *
 * Persisted, unlike `useCoworkRun`: a workflow that was running when the app
 * closed has to come back as a record of what happened rather than vanishing,
 * and the inline card has to survive a reload. What cannot survive is a
 * *running* task — the subagent's stream and the shell's process both died
 * with the process that owned them — so `recoverOnLoad` settles anything the
 * previous app run left in flight.
 */
type CoworkActivityState = ActivityState & {
  /** Record a run that has just dispatched its first background work. */
  beginWorkflow: (workflow: ActivityWorkflow) => void
  /** Note the phase a dispatch happened under; returns its stable id. */
  notePhase: (
    workflowId: string,
    phase: { name: string; index: number }
  ) => string | undefined
  /** Record a dispatched unit of work. */
  beginTask: (task: ActivityTask) => void
  /** Merge an update onto a task. */
  patchTask: (id: string, patch: Partial<ActivityTask>) => void
  /** Close a workflow once its run is over. */
  finishWorkflow: (id: string) => void
  /**
   * Settle what one run left behind when it ended.
   *
   * Scoped to that run's workflow, and leaving alone the one kind of work that
   * outlives a run — a shell command already handed a backend job id, whose
   * process is still running.
   */
  settleRun: (workflowId: string, reason: string) => void
  /** Settle a session's live work outright, for clearing or deleting it. */
  settleSession: (sessionId: string, reason: string) => void
  /** Hide every finished workflow of a session, keeping the records. */
  clearFinished: (sessionId: string) => void
  /** Hide a session's finished background rows (all), or one by id. */
  clearBackground: (match: { id: string } | { sessionId: string }) => void
  /** Forget everything belonging to a session that no longer exists. */
  dropSession: (sessionId: string) => void
  /** Settle work the previous app run left in flight. */
  recoverOnLoad: (reason: string) => void
}

const now = () => Date.now()

export const useCoworkActivity = create<CoworkActivityState>()(
  persist(
    (set) => ({
      ...emptyActivityState(),

      beginWorkflow: (workflow) => set((s) => startWorkflow(s, workflow)),

      notePhase: (workflowId, phase) => {
        let phaseId: string | undefined
        set((s) => {
          const result = observePhase(s, workflowId, phase)
          phaseId = result.phaseId
          return result.state
        })
        return phaseId
      },

      beginTask: (task) => set((s) => startTask(s, task)),

      patchTask: (id, patch) => set((s) => updateTask(s, id, patch)),

      finishWorkflow: (id) => set((s) => endWorkflow(s, id, now())),

      settleRun: (workflowId, reason) =>
        set((s) => settleRunOrphans(s, workflowId, now(), reason)),

      settleSession: (sessionId, reason) =>
        set((s) => settleSessionWork(s, sessionId, now(), reason)),

      clearFinished: (sessionId) =>
        set((s) => dismissFinished(s, sessionId, now())),

      clearBackground: (match) => set((s) => dismissBackground(s, match)),

      dropSession: (sessionId) => set((s) => forgetSession(s, sessionId)),

      recoverOnLoad: (reason) => set((s) => settleOnLoad(s, now(), reason)),
    }),
    {
      name: localStorageKey.coworkActivity,
      // Through the Rust settings store, like the sessions themselves, so the
      // record lives in <jan_data>/settings.json rather than webview
      // localStorage. Async storage requires skipHydration plus an explicit
      // rehydrate in hydrateBackendStores().
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      version: 2,
      // v1 keyed tasks by the provider's raw call id, which nothing guarantees
      // is unique across sessions, runs or providers. v2 keys them by session,
      // workflow and call id together, and keeps the raw id as `callId` for
      // correlating with the transcript and the backend's job list.
      migrate: (persisted, version) => {
        const state = persisted as ActivityState | undefined
        if (!state?.tasks || version >= 2) return persisted
        const tasks: Record<string, ActivityTask> = {}
        for (const [key, task] of Object.entries(state.tasks)) {
          const callId = task.callId ?? key
          const id = taskIdFor(task.sessionId, task.workflowId, callId)
          tasks[id] = { ...task, id, callId }
        }
        // Parent links named the old keys, so re-point them the same way.
        for (const task of Object.values(tasks)) {
          if (!task.parentTaskId) continue
          const parent = Object.values(tasks).find(
            (one) =>
              one.callId === task.parentTaskId &&
              one.workflowId === task.workflowId
          )
          task.parentTaskId = parent?.id
        }
        return { ...state, tasks }
      },
      // Only the record is persisted; the actions are rebuilt on load.
      partialize: (state) => ({
        workflows: state.workflows,
        tasks: state.tasks,
      }),
    }
  )
)
