import type { StateCreator } from 'zustand'
import {
  extraFoldersOf,
  withExtraFolder,
  withoutExtraFolder,
} from '@/lib/coworkFolders'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import {
  emptyCodePanelState,
  projectKeyOf,
  pruneTabsForProject,
} from '@/lib/coworkCode'
import type { TodoList } from '@/types/coworkSession'
import { recover as recoverInterrupted } from '@/lib/coworkInflight'
import { defaultModeFor } from '@/lib/coworkMode'
import {
  sanitizeSender,
  stamped,
  withStoredTimes,
} from '@/lib/coworkSessionStamps'
import type {
  CoworkSessionsState,
  PendingInputRecord,
  TodoSnapshot,
} from './types'

const now = () => Date.now()

/**
 * Keeps one snapshot per run: a later write from the same run replaces its
 * snapshot, a run that writes a list for the first time adds one.
 */
export function recordTodoSnapshot(
  snapshots: TodoSnapshot[] | undefined,
  anchorId: string,
  list: TodoList
): TodoSnapshot[] {
  const rest = (snapshots ?? []).filter((s) => s.anchorId !== anchorId)
  return [...rest, { anchorId, list }]
}

export type SessionUpdatesSlice = Pick<
  CoworkSessionsState,
  | 'setModel'
  | 'setPendingInput'
  | 'setFolder'
  | 'addExtraFolder'
  | 'removeExtraFolder'
  | 'setExtraFolderWritable'
  | 'setMainFolderReadOnly'
  | 'setMessages'
  | 'setGoal'
  | 'setTodos'
  | 'setProgressUi'
  | 'setAccess'
  | 'grantEditConsent'
  | 'setContinuity'
  | 'setRunBudget'
  | 'setInFlight'
  | 'recoverInFlight'
  | 'setMode'
  | 'setCodePanel'
  | 'setTitle'
  | 'setCampaign'
>

export const createSessionUpdatesSlice: StateCreator<
  CoworkSessionsState,
  [['zustand/persist', unknown]],
  [],
  SessionUpdatesSlice
> = (set, get) => ({
  setModel: (id, model) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, model: { ...model } } : x
      ),
    })),

  setPendingInput: (id, pending) =>
    set((s) => {
      const current = s.sessions.find((x) => x.id === id)
      if (!current) return s
      const next: PendingInputRecord[] = pending.map(
        ({ id, text, createdAt, from }) =>
          from
            ? { id, text, createdAt, from: sanitizeSender(from) }
            : { id, text, createdAt }
      )
      if (JSON.stringify(current.pendingInput ?? []) === JSON.stringify(next)) {
        return s
      }
      return {
        sessions: s.sessions.map((x) =>
          x.id === id
            ? { ...x, pendingInput: next.length > 0 ? next : undefined }
            : x
        ),
      }
    }),

  // Attaching, switching and detaching all land here, so the code panel is
  // pruned in the same update: a tab from the old project must never be
  // left to re-resolve its relative path inside the new one.
  setFolder: (id, folder) => {
    const current = get().sessions.find((session) => session.id === id)
    if (current && current.folder !== folder) {
      // Session records are keyed by id. Never carry previous folder's
      // checkout into a newly attached project.
      useCoworkWorktrees.getState().forget(id)
    }
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? {
              ...x,
              folder,
              // The new primary is not also an extra folder.
              extraFolders: folder
                ? withoutExtraFolder(extraFoldersOf(x), folder)
                : x.extraFolders,
              // Attaching a repository to a session that has not run yet
              // puts it in Ask: every change waits for the user, and the
              // opening turn is read-only on its own. A mode the user chose,
              // or one a legacy session already implies, is left alone —
              // and so is detaching, which must not stamp a mode that
              // would then suppress this default on the next attach.
              mode: folder
                ? (x.mode ??
                  (x.turns.length === 0 &&
                  x.messages.length === 0 &&
                  x.planMode === undefined
                    ? defaultModeFor(folder)
                    : undefined))
                : x.mode,
              // Attaching a folder defaults to direct editing. The route
              // obtains a scoped backend grant before any tool can write.
              // Users who explicitly enabled automatic worktrees keep
              // that behavior; later mode choices stay in force.
              access:
                folder === x.folder
                  ? x.access
                  : folder
                    ? useCoworkParallel.getState().autoWorktree
                      ? 'review-only'
                      : 'edit-folder'
                    : 'review-only',
              editConsent:
                folder === x.folder && x.editConsent?.folder === folder
                  ? x.editConsent
                  : undefined,
              codePanel: pruneTabsForProject(
                x.codePanel ?? emptyCodePanelState(),
                projectKeyOf(folder)
              ),
              updated: now(),
            }
          : x
      ),
    }))
  },

  // Changing which folders are attached withdraws the access agreed for the
  // old set, as changing the primary does: a grant covers the folders it
  // was issued for, and silently widening it would be authority nobody
  // confirmed.
  addExtraFolder: (id, folder) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? {
              ...x,
              extraFolders: withExtraFolder(
                x.folder,
                extraFoldersOf(x),
                folder
              ),
              access: 'review-only',
              editConsent: undefined,
              updated: now(),
            }
          : x
      ),
    })),

  removeExtraFolder: (id, folder) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? {
              ...x,
              extraFolders: withoutExtraFolder(extraFoldersOf(x), folder),
              readOnlyExtraFolders: x.readOnlyExtraFolders
                ? withoutExtraFolder(x.readOnlyExtraFolders, folder)
                : undefined,
              access: 'review-only',
              editConsent: undefined,
              updated: now(),
            }
          : x
      ),
    })),

  // Only the mark changes: the caller re-issues the grant for the new set.
  setExtraFolderWritable: (id, folder, writable) =>
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== id) return x
        const rest = withoutExtraFolder(x.readOnlyExtraFolders ?? [], folder)
        return {
          ...x,
          readOnlyExtraFolders: writable ? rest : [...rest, folder],
          updated: now(),
        }
      }),
    })),

  setMainFolderReadOnly: (id, readOnly) =>
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== id) return x
        const next = { ...x, updated: now() }
        if (readOnly === undefined) delete next.mainFolderReadOnly
        else next.mainFolderReadOnly = readOnly
        return next
      }),
    })),

  setMessages: (id, messages) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? {
              ...x,
              messages: withStoredTimes(x.messages, messages, now()),
              updated: now(),
            }
          : x
      ),
    })),

  setGoal: (id, goal) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, goal: goal ?? undefined } : x
      ),
    })),

  setTodos: (id, todos, anchorId) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? {
              ...x,
              todos,
              todoSnapshots: anchorId
                ? recordTodoSnapshot(x.todoSnapshots, anchorId, todos)
                : x.todoSnapshots,
            }
          : x
      ),
    })),

  setProgressUi: (id, patch) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, progressUi: { ...x.progressUi, ...patch } } : x
      ),
    })),

  setAccess: (id, access) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, access, updated: now() } : x
      ),
    })),

  grantEditConsent: (id, folder) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? { ...x, editConsent: { sessionId: id, folder }, updated: now() }
          : x
      ),
    })),

  setContinuity: (id, continuity) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, continuity: continuity ?? undefined } : x
      ),
    })),

  setRunBudget: (id, runBudget) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, runBudget: runBudget ?? undefined } : x
      ),
    })),

  setInFlight: (id, record) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, inFlight: record ?? undefined } : x
      ),
    })),

  recoverInFlight: (id, choice) => {
    const session = get().sessions.find((x) => x.id === id)
    if (!session?.inFlight) return false
    const { turns, messages } = recoverInterrupted(
      session.messages ?? [],
      session.inFlight,
      choice,
      id
    )
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? {
              ...x,
              turns: [...x.turns, ...stamped(turns)],
              messages: withStoredTimes(x.messages ?? [], messages, now()),
              inFlight: undefined,
              // The dead run's budget is not this one's.
              runBudget: undefined,
              updated: now(),
            }
          : x
      ),
    }))
    return true
  },

  setMode: (id, mode) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        // `planMode` is cleared as well, so the legacy field can never
        // disagree with the explicit choice just made.
        x.id === id
          ? { ...x, mode, planMode: undefined, updated: now() }
          : x
      ),
    })),

  // `updated` untouched on purpose: switching a tab is not "session
  // activity" and must not reorder the session list.
  setCodePanel: (id, codePanel) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, codePanel } : x
      ),
    })),

  setTitle: (id, title) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)),
    })),

  setCampaign: (id, campaign) =>
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== id) return x
        const { campaign: _drop, ...rest } = x
        void _drop
        return campaign ? { ...rest, campaign } : rest
      }),
    })),
})
