import {
  extraFoldersOf,
  withExtraFolder,
  withoutExtraFolder,
} from '@/lib/coworkFolders'
import type { UIMessage } from 'ai'
import { create } from 'zustand'
import { useUsageStats } from '@/stores/usage-stats-store'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import { coworkTurnsToUIMessages } from '@/lib/coworkTurns'
import type { HandoffRecord } from '@/lib/sessionHandoff'
import type { ContinuityRecord } from '@/lib/coworkContinuity'
import {
  emptyCodePanelState,
  projectKeyOf,
  projectTab,
  pruneTabsForProject,
  sandboxTab,
  tabId,
  type CodePanelState,
  type CodeTab,
  type FileOrigin,
} from '@/lib/coworkCode'

/** The `sandbox:` marker used by the v2 tab-path scheme. */
const LEGACY_SANDBOX_PREFIX = 'sandbox:'
import type {
  CoworkTurn,
  SubagentRun,
  Usage,
  CoworkGoal,
  TodoList,
} from '@/types/coworkSession'

// The transcript/todo/subagent shapes live in a store-free module so panels and
// pure helpers can import them without pulling in zustand. Re-exported here
// because this store is still their most natural import site.
/** Counts a committed run's replies for the Overview dashboard. */
function recordCoworkUsage(turns: CoworkTurn[]) {
  const stats = useUsageStats.getState()
  for (const turn of turns) {
    if (turn.role !== 'assistant') continue
    const tokens = turn.tokenSpeed?.tokenCount ?? turn.usage?.completion_tokens ?? 0
    const speed = turn.tokenSpeed?.tokenSpeed ?? 0
    stats.recordGeneration({
      tokens,
      durationMs: speed > 0 && tokens > 0 ? (tokens / speed) * 1000 : 0,
      at: turn.endedAt ?? Date.now(),
    })
  }
}

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

/**
 * @deprecated Superseded by `CoworkSession.messages`. This shape cannot model
 * tool calls, so replaying it drops every tool turn — survivable while Rust
 * owned the loop and kept its own history, but not now the client is the
 * history. Retained only so sessions persisted by an earlier build still load.
 */
export type CoworkMessage = {
  role: 'user' | 'assistant'
  content: string
}

/** The plan at one run, placed in the transcript after `anchorId`. */
export type TodoSnapshot = { anchorId: string; list: TodoList }

export type ProgressUi = { expanded?: boolean; unpinned?: boolean }

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

export type CoworkSession = {
  id: string
  title: string
  /** An attached project folder, mounted read-only. Writes always land in the
   * session's own sandbox, never here. */
  folder: string | null
  /**
   * Folders attached beside `folder`, in the order the user added them, like
   * a multi-root workspace. Each is readable and writable exactly like the
   * primary; the shell still starts in the primary. Absent on sessions saved
   * before this existed, which have the primary alone. Read through
   * `extraFoldersOf`.
   */
  extraFolders?: string[]
  turns: CoworkTurn[]
  /** The authoritative conversation, sent to the model each turn. */
  messages: UIMessage[]
  /** @deprecated Read once to migrate into `messages`, then left alone. */
  history?: CoworkMessage[]
  /** Finished subagent runs across this session, merged by runId. */
  subagents?: SubagentRun[]
  /** Usage from the most recent completed run. */
  lastUsage?: Usage
  /** `/goal` state: checked after each turn, cleared when met. */
  goal?: CoworkGoal
  /** Canonical session todo list, updated by the `todo_write` tool. */
  todos?: TodoList
  /**
   * The plan as it stood at each run that wrote one, anchored at that run's
   * prompt message: one per run, the latest write of the run kept.
   */
  todoSnapshots?: TodoSnapshot[]
  /** The pinned plan strip's state: open or folded, and whether unpinned. */
  progressUi?: ProgressUi
  /**
   * @deprecated Superseded by `mode`. Kept so sessions saved before modes
   * existed keep their meaning; read through `modeOf`, never directly.
   */
  planMode?: boolean
  /**
   * The provider/model this session runs on (janhq/jan#8905).
   *
   * The session's own, not the global picker's: changing the model while
   * viewing one session no longer changes another's, and it survives a
   * restart with the rest of the session. Absent on a session that has not
   * chosen one yet; its first run records the model it used.
   */
  model?: { provider: string; id: string }
  /**
   * Input typed for this session that no run has taken yet, kept so a restart
   * brings it back -- held, for the user to send or discard -- rather than
   * losing it. janhq/jan#8864.
   */
  pendingInput?: PendingInputRecord[]
  /**
   * What this session is allowed to do. Absent on sessions from before modes
   * existed, which `modeOf` reads from `planMode` instead.
   */
  mode?: CoworkMode
  /**
   * Where this session may write. Absent means Review only — silence from a
   * session saved before access modes existed is not permission.
   */
  access?: AccessMode
  /**
   * Confirmation to edit the attached folder, naming the session and folder it
   * was given for so it cannot follow the user to another repository.
   */
  editConsent?: EditConsent
  /**
   * Where this session is in the opening exchange with its repository.
   *
   * Absent on sessions that never had one, and on every session saved before
   * this existed — which reads as "no proposal is outstanding", the state that
   * grants nothing.
   */
  continuity?: ContinuityRecord
  /** Code panel state: open tabs, active tab, explorer expansion, word wrap.
   * Absent on sessions from before the code workspace existed. */
  codePanel?: CodePanelState
  /**
   * What the run in progress has spent, and by when it must be over.
   * AH-018/AH-019.
   *
   * Persisted so a restart does not hand a half-finished run a fresh budget:
   * the wall clock kept running while the app was closed, and the steps
   * already taken were still taken. Absent on sessions saved before this
   * existed and on sessions with nothing running, both of which read as "no
   * run is outstanding".
   */
  runBudget?: RunBudgetRecord
  /**
   * The turn the run in progress is in the middle of (AH-026).
   *
   * Written while the run goes and cleared when its turns are committed, so a
   * run the app was closed or killed under comes back as an interrupted turn
   * -- its completed tool calls and its unfinished reply -- rather than as
   * nothing. Absent on sessions with nothing in flight.
   */
  inFlight?: InFlightRecord
  /**
   * Where this session came from, when it was forked from another. AH-201.
   *
   * Provenance only. It grants nothing: a fork carries no folder, no grant, no
   * consent and no worktree, and asks for its own. Absent on every session
   * that was started rather than forked.
   */
  forkedFrom?: ForkOrigin
  /**
   * The export this session was imported from. AH-203.
   *
   * Provenance, and what makes a second import of the same file a refusal
   * rather than a duplicate. Grants nothing.
   */
  importedFrom?: ImportedFrom
  /**
   * What a handed-off session could not bring from the other computer.
   * AH-210. Grants nothing: the folder it names must be attached here, by
   * the user, like any other.
   */
  handoff?: HandoffRecord
  updated: number
}

/**
 * One queued input as persisted. `from` is present when it is mail from another
 * agent session (docs/SESSION_MESSAGING.md); it is additive, so sessions saved
 * before it existed load unchanged and need no migration step.
 */
export type PendingInputRecord = {
  id: string
  text: string
  createdAt: number
  from?: QueuedMessageSender
}

/** The session a fork came from, and where it diverged. */
export type ForkOrigin = {
  sessionId: string
  /**
   * How many turns of the parent this fork copied.
   *
   * A count rather than a turn id: turns have no ids of their own, and the
   * count is what "identical up to here" actually means.
   */
  turns: number
  /** When the fork was taken. */
  at: number
}

/** One run's spend, as it stands. */
export type RunBudgetRecord = {
  runId: string
  /** Steps taken so far. */
  steps: number
  /** The cap in force for this run. */
  maxSteps: number
  /** Epoch millis the run must be over by, and the budget it came from. */
  deadlineAt: number
  deadlineBudgetMs: number
}

type CoworkSessionsState = {
  sessions: CoworkSession[]
  currentId: string | null
  createSession: () => string
  /**
   * What "New session" does: create one, or stay put when this session is
   * already blank. An unsent draft is parked on the session it was typed in
   * as held input when that session has content, so the new one opens blank;
   * on a blank session the draft stays in the composer. Returns the session
   * to show.
   */
  startSession: (input: { running: boolean; draft?: string }) => string
  /**
   * `startSession`, also reporting whether the draft was parked. Only then may
   * the caller clear its composer: a draft that was not parked (blank session,
   * or no session to park it on) would be lost by clearing.
   */
  startSessionParked: (input: {
    running: boolean
    draft?: string
  }) => { id: string; parked: boolean }
  selectSession: (id: string) => void
  deleteSession: (id: string) => void
  /**
   * Fork a session at a turn, producing an independent one. AH-201.
   *
   * `throughTurn` is how many turns to keep; omitted forks the whole
   * conversation. Returns the new session's id, or null when there is nothing
   * to fork -- an unknown session, or a divergence point that is not in the
   * conversation.
   */
  forkSession: (id: string, throughTurn?: number) => string | null
  /**
   * Create a session from an export. AH-203.
   *
   * A new id, no folder, no access; questions left pending come back stale.
   * An export already imported is refused, naming the session it became.
   */
  importSession: (
    bundle: SessionBundle,
    /** For a handoff (AH-210): what could not be restored here. */
    handoff?: HandoffRecord
  ) => { ok: true; id: string } | { ok: false; refusal: ImportRefusal }
  /** The user has read what a handoff could not restore. */
  dismissHandoff: (id: string) => void
  setFolder: (id: string, folder: string | null) => void
  /** Attach another folder beside the primary one. */
  addExtraFolder: (id: string, folder: string) => void
  /** Detach one of the extra folders. */
  removeExtraFolder: (id: string, folder: string) => void
  /** The session's own provider/model choice (janhq/jan#8905). */
  setModel: (id: string, model: { provider: string; id: string }) => void
  /** Record the input still pending for the session; empty clears it. */
  setPendingInput: (id: string, pending: PendingInputRecord[]) => void
  setMode: (id: string, mode: CoworkMode) => void
  /** Record, or clear, where the session is in its opening exchange. */
  setContinuity: (id: string, continuity: ContinuityRecord | null) => void
  /** Record, or clear, what the run in progress has spent. */
  setRunBudget: (id: string, budget: RunBudgetRecord | null) => void
  /** Keep, or clear, the turn the session's run is in the middle of. AH-026. */
  setInFlight: (id: string, record: InFlightRecord | null) => void
  /**
   * Take an interrupted turn back into the session, as the user chose, so the
   * next run continues from it. AH-026.
   */
  recoverInFlight: (id: string, choice: InterruptedChoice) => boolean
  setAccess: (id: string, access: AccessMode) => void
  /** Record the user's confirmation to edit `folder` in this session. */
  grantEditConsent: (id: string, folder: string) => void
  /** Replace the session's code-panel state (tabs, expansion, word wrap). */
  setCodePanel: (id: string, codePanel: CodePanelState) => void
  setTitle: (id: string, title: string) => void
  setMessages: (id: string, messages: UIMessage[]) => void
  setGoal: (id: string, goal: CoworkGoal | null) => void
  setTodos: (id: string, todos: TodoList, anchorId?: string) => void
  setProgressUi: (id: string, patch: ProgressUi) => void
  /**
   * @deprecated Bridge for the pre-AI-SDK Cowork route, which has no
   * `UIMessage[]` to commit. Removed together with that route.
   */
  commitLegacyTurns: (
    id: string,
    turns: CoworkTurn[],
    history: CoworkMessage[]
  ) => void
  commitTurns: (
    id: string,
    turns: CoworkTurn[],
    messages: UIMessage[],
    subagents: SubagentRun[],
    usage?: Usage
  ) => void
  /** Drop everything the agent produced since the last question, so the run can
   * be taken again. Both lists are rewound together or the transcript and the
   * history the model sees would disagree. */
  /**
   * Add display-only rows to a session's transcript without touching the
   * model history (e.g. "Stopped by <session>"). Nothing is sent to a model.
   */
  appendTurns: (id: string, turns: CoworkTurn[]) => void
  rewindToLastUser: (id: string) => void
  clearSession: (id: string) => void
}

import {
  decideSessionStart,
  DEFAULT_SESSION_TITLE,
  isSessionEmpty,
  pruneEmptySessions,
} from '@/lib/coworkSessionStart'
import {
  recover as recoverInterrupted,
  type InFlightRecord,
  type InterruptedChoice,
} from '@/lib/coworkInflight'
import { defaultModeFor, type CoworkMode } from '@/lib/coworkMode'
import type { AccessMode, EditConsent } from '@/lib/coworkAccess'
import { useFileActivity } from '@/hooks/useFileActivity'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import type { QueuedMessageSender } from '@/stores/message-queue-store'
import {
  checkBundle,
  importedFileActivity,
  importedTurns,
  type ImportedFrom,
  type ImportRefusal,
  type SessionBundle,
} from '@/lib/sessionBundle'
import { fromCoworkUsage, toCoworkUsage } from '@/lib/tokenUsage'
import { deletePromptSnapshots } from '@/lib/promptSnapshotRetention'

const now = () => Date.now()

/** An imported session's usage, normalised the same way a live one is. */
function importedUsage(raw: unknown): Usage | undefined {
  const usage = fromCoworkUsage(
    raw && typeof raw === 'object' ? (raw as Usage) : undefined
  )
  return usage && Object.keys(usage).length > 0 ? toCoworkUsage(usage) : undefined
}

/** Only the sender fields the queue defines are persisted. */
function sanitizeSender(from: QueuedMessageSender): QueuedMessageSender {
  return {
    sessionId: from.sessionId,
    displayName: from.displayName,
    messageId: from.messageId,
    replyTo: from.replyTo ?? null,
    depth: from.depth,
  }
}

export const useCoworkSessions = create<CoworkSessionsState>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentId: null,

      createSession: () => {
        const id = crypto.randomUUID()
        const session: CoworkSession = {
          id,
          title: DEFAULT_SESSION_TITLE,
          folder: null,
          turns: [],
          messages: [],
          updated: now(),
        }
        // Starting a new one leaves any blank session behind it: a blank
        // holds nothing, so keeping it only lengthens the list.
        set((s) => ({
          sessions: dropBlanks([session, ...s.sessions], id),
          currentId: id,
        }))
        return id
      },

      startSession: (input) => get().startSessionParked(input).id,

      startSessionParked: ({ running, draft }) => {
        const state = get()
        const current = state.sessions.find((s) => s.id === state.currentId)
        // Asked here rather than at each call site so every entry point to
        // "New session" judges emptiness the same way.
        const hasFileActivity = current
          ? useFileActivity.getState().eventsFor(current.id).length > 0
          : false
        if (
          current &&
          decideSessionStart({ current, running, hasFileActivity }) === 'reuse'
        ) {
          // Blank: this is already the new session, and a draft typed in it
          // belongs there. Parking it on a blank session hid it (blanks are
          // hidden from the list) and wiped the composer.
          return { id: current.id, parked: false }
        }
        // The caller supplies the draft from the composer it owns.
        const parked = Boolean(current && draft?.trim())
        if (current && parked) {
          get().setPendingInput(current.id, [
            ...(current.pendingInput ?? []),
            {
              id: crypto.randomUUID(),
              text: draft as string,
              createdAt: Date.now(),
            },
          ])
        }
        return { id: get().createSession(), parked }
      },

      // Leaving a blank session discards it, so pressing New session and then
      // going back to an older one does not leave an empty entry behind.
      selectSession: (id) =>
        set((s) => ({ sessions: dropBlanks(s.sessions, id), currentId: id })),

      forkSession: (id, throughTurn) => {
        const parent = get().sessions.find((x) => x.id === id)
        // No session, or a divergence point outside the conversation. Refused
        // rather than clamped: a fork silently taken at a different turn than
        // the one asked for is not the thing the user asked for.
        if (!parent) return null
        const keep = throughTurn ?? parent.turns.length
        if (!Number.isInteger(keep) || keep < 0 || keep > parent.turns.length) {
          return null
        }

        const turns = parent.turns.slice(0, keep)
        const forkId = crypto.randomUUID()
        const fork: CoworkSession = {
          id: forkId,
          title: parent.title ? `${parent.title} (fork)` : 'New session',
          turns,
          // Rebuilt from the kept turns rather than sliced from the parent's
          // messages: the two arrays do not correspond one to one, and a
          // message array cut at the wrong index sends the model half a turn.
          messages: coworkTurnsToUIMessages(turns, forkId),
          /*
           * Nothing that grants anything is copied.
           *
           * A fork starts unbound: no folder, no write grant, no edit consent,
           * no worktree, no access mode. Inheriting them would let a user
           * multiply the authority they were given once by forking, and would
           * point two sessions at one checkout without either knowing.
           */
          folder: null,
          mode: parent.mode,
          todos: parent.todos,
          goal: parent.goal,
          forkedFrom: { sessionId: parent.id, turns: keep, at: now() },
          updated: now(),
        }

        set((s) => ({ sessions: [fork, ...s.sessions], currentId: forkId }))
        return forkId
      },

      dismissHandoff: (id) =>
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === id && x.handoff
              ? { ...x, handoff: { ...x.handoff, dismissed: true } }
              : x
          ),
        })),

      importSession: (bundle, handoff) => {
        const problem = checkBundle(bundle)
        if (problem) {
          return { ok: false, refusal: { reason: 'invalid', message: problem } }
        }
        const existing = get().sessions.find(
          (x) => x.importedFrom?.exportId === bundle.exportId
        )
        if (existing) {
          return {
            ok: false,
            refusal: { reason: 'already-imported', sessionId: existing.id },
          }
        }
        const id = crypto.randomUUID()
        const turns = importedTurns(bundle.session.turns, id)
        const session: CoworkSession = {
          id,
          title: bundle.session.title || 'Imported session',
          turns,
          messages: coworkTurnsToUIMessages(turns, id),
          subagents: bundle.session.subagents,
          // Unbound, like a fork: the export carried no authority and this
          // machine has granted none.
          folder: null,
          mode: bundle.session.mode,
          goal: bundle.session.goal,
          todos: bundle.session.todos,
          forkedFrom: bundle.session.forkedFrom,
          // Re-read rather than trusted: a hand-edited file cannot plant a
          // negative, a string or a cached count larger than the input.
          lastUsage: importedUsage(bundle.session.lastUsage),
          importedFrom: {
            exportId: bundle.exportId,
            sessionId: bundle.session.id,
            at: now(),
          },
          handoff,
          updated: now(),
        }
        set((s) => ({ sessions: [session, ...s.sessions], currentId: id }))
        const events = importedFileActivity(bundle.fileActivity ?? [], id)
        if (events.length) useFileActivity.getState().record(id, events)
        return { ok: true, id }
      },

      deleteSession: (id) =>
        set((s) => {
          void deletePromptSnapshots(id)
          const sessions = s.sessions.filter((x) => x.id !== id)
          const currentId =
            s.currentId === id ? (sessions[0]?.id ?? null) : s.currentId
          return { sessions, currentId }
        }),

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
      setFolder: (id, folder) =>
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
        })),

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
                  access: 'review-only',
                  editConsent: undefined,
                  updated: now(),
                }
              : x
          ),
        })),

      setMessages: (id, messages) =>
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === id ? { ...x, messages, updated: now() } : x
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
                  turns: [...x.turns, ...turns],
                  messages,
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

      commitLegacyTurns: (id, turns, history) =>
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === id
              ? { ...x, turns: [...x.turns, ...turns], history, updated: now() }
              : x
          ),
        })),

      commitTurns: (id, turns, messages, subagents, usage) => {
        recordCoworkUsage(turns)
        set((s) => ({
          sessions: s.sessions.map((x) => {
            if (x.id !== id) return x
            // Accumulate across this session's runs, keyed by runId — a later
            // run that dispatches no subagents of its own must not erase what
            // an earlier run in the same session already finished.
            const incoming = new Set(subagents.map((r) => r.runId))
            return {
              ...x,
              turns: [...x.turns, ...turns],
              messages,
              subagents: [
                ...(x.subagents ?? []).filter((r) => !incoming.has(r.runId)),
                ...subagents,
              ],
              lastUsage: usage ?? x.lastUsage,
              // Committed, so nothing of this run is in flight any more.
              inFlight: undefined,
              updated: now(),
            }
          }),
        }))
      },

      appendTurns: (id, turns) =>
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === id
              ? { ...x, turns: [...x.turns, ...turns], updated: now() }
              : x
          ),
        })),

      rewindToLastUser: (id) =>
        set((s) => ({
          sessions: s.sessions.map((x) => {
            if (x.id !== id) return x
            const lastIndexOfUser = (roles: { role: string }[]) => {
              for (let i = roles.length - 1; i >= 0; i--) {
                if (roles[i].role === 'user') return i
              }
              return -1
            }
            const lastTurn = lastIndexOfUser(x.turns)
            const lastMessage = lastIndexOfUser(x.messages)
            if (lastTurn < 0 || lastMessage < 0) return x
            return {
              ...x,
              turns: x.turns.slice(0, lastTurn + 1),
              messages: x.messages.slice(0, lastMessage + 1),
              updated: now(),
            }
          }),
        })),

      clearSession: (id) =>
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === id
              ? {
                  ...x,
                  turns: [],
                  messages: [],
                  subagents: [],
                  lastUsage: undefined,
                  updated: now(),
                }
              : x
          ),
        })),
    }),
    {
      name: localStorageKey.coworkSessions,
      // Persist through the Rust settings store (see backendStorage) so sessions
      // live in <jan_data>/settings.json instead of webview localStorage.
      // Async storage requires skipHydration + explicit rehydrate in
      // hydrateBackendStores() once the ServiceHub is ready.
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
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
      version: 4,
      // v0 persisted an OpenAI-shaped `history` that could not represent tool
      // calls, so replaying it dropped every tool turn. Rebuild the message
      // list from `turns`, which did record them, and leave `history` in place
      // untouched rather than mutating a blob a rollback would still read.
      //
      // v1 → v2 adds `codePanel`. Filled with the empty state rather than left
      // absent so downstream code reads one shape; every other field is passed
      // through untouched, so a v1 session loses nothing.
      migrate: (persisted, version) => {
        const state = persisted as { sessions?: CoworkSession[] } | undefined
        if (!state?.sessions) return persisted
        let sessions = state.sessions
        if (version < 1) {
          sessions = sessions.map((session) =>
            session.messages
              ? session
              : {
                  ...session,
                  messages: coworkTurnsToUIMessages(
                    session.turns ?? [],
                    session.id
                  ),
                }
          )
        }
        if (version < 2) {
          sessions = sessions.map((session) =>
            session.codePanel
              ? session
              : { ...session, codePanel: emptyCodePanelState() }
          )
        }
        // v2 → v3: tabs were bare strings with a `sandbox:` prefix and no idea
        // which project they came from, so a tab opened against one project
        // would silently re-resolve inside the next one attached. Each becomes
        // a CodeTab carrying its origin; a project tab is keyed to the folder
        // the session has now, and dropped when there is none, because nothing
        // records which project it was actually read from.
        if (version < 3) {
          sessions = sessions.map((session) => {
            const legacy = session.codePanel as unknown as
              | { openPaths?: unknown; activePath?: unknown }
              | undefined
            if (!legacy || !Array.isArray(legacy.openPaths)) {
              return session.codePanel
                ? session
                : { ...session, codePanel: emptyCodePanelState() }
            }
            const projectKey = projectKeyOf(session.folder)
            const tabs: CodeTab[] = []
            for (const raw of legacy.openPaths) {
              if (typeof raw !== 'string' || !raw) continue
              if (raw.startsWith(LEGACY_SANDBOX_PREFIX)) {
                // The tab is stored on its own session, so that session owns it.
                tabs.push(
                  sandboxTab(
                    raw.slice(LEGACY_SANDBOX_PREFIX.length),
                    session.id
                  )
                )
              } else if (projectKey) {
                tabs.push(projectTab(raw, projectKey))
              }
            }
            const previousActive =
              typeof legacy.activePath === 'string' ? legacy.activePath : null
            const active = tabs.find((tab) =>
              previousActive === null
                ? false
                : previousActive.startsWith(LEGACY_SANDBOX_PREFIX)
                  ? tab.origin.kind !== 'project' &&
                    tab.path ===
                      previousActive.slice(LEGACY_SANDBOX_PREFIX.length)
                  : tab.origin.kind === 'project' && tab.path === previousActive
            )
            return {
              ...session,
              codePanel: {
                tabs,
                activeTabId: active
                  ? tabId(active)
                  : tabs[0]
                    ? tabId(tabs[0])
                    : null,
                expandedDirs: Array.isArray(
                  (session.codePanel as unknown as { expandedDirs?: unknown })
                    ?.expandedDirs
                )
                  ? (session.codePanel as unknown as { expandedDirs: string[] })
                      .expandedDirs
                  : [],
                wordWrap: Boolean(
                  (session.codePanel as unknown as { wordWrap?: unknown })
                    ?.wordWrap
                ),
              },
            }
          })
        }
        // v3 → v4: sandbox and artifact origins gained a `sessionKey`. Without
        // one a tab has no owner, so it would be read against whichever
        // session happened to be open. Each is stamped with the session it is
        // stored on, which is the session that opened it.
        if (version < 4) {
          sessions = sessions.map((session) => {
            const panel = session.codePanel
            if (!panel?.tabs?.length) return session
            let changed = false
            const tabs = panel.tabs.map((tab) => {
              const origin = tab.origin as FileOrigin & { sessionKey?: string }
              if (
                (origin?.kind !== 'sandbox' && origin?.kind !== 'artifact') ||
                origin.sessionKey
              ) {
                return tab
              }
              changed = true
              return {
                ...tab,
                origin: { kind: origin.kind, sessionKey: session.id },
              }
            })
            if (!changed) return session
            // Tab ids embed the origin, so every id just changed. Re-derive
            // the active one from the tab it pointed at rather than leaving a
            // dangling id that would blank the viewer.
            const activeIndex = panel.tabs.findIndex(
              (tab) => tabId(tab) === panel.activeTabId
            )
            return {
              ...session,
              codePanel: {
                ...panel,
                tabs,
                activeTabId:
                  activeIndex >= 0
                    ? tabId(tabs[activeIndex])
                    : panel.activeTabId,
              },
            }
          })
        }
        return { ...state, sessions }
      },
    }
  )
)

/**
 * The sessions without the blank ones, except `keepId`. A session with a run
 * going, file activity or held input is not blank, whatever its turns say.
 */
function dropBlanks(sessions: CoworkSession[], keepId: string): CoworkSession[] {
  const runs = useCoworkRun.getState().runs ?? {}
  const files = useFileActivity.getState()
  const next = sessions.filter(
    (s) =>
      s.id === keepId ||
      !isSessionEmpty(s) ||
      s.title !== DEFAULT_SESSION_TITLE ||
      Boolean(runs[s.id]) ||
      (s.pendingInput?.length ?? 0) > 0 ||
      files.eventsFor(s.id).length > 0
  )
  return next.length === sessions.length ? sessions : next
}

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
  }
  useCoworkSessions.setState((s) => ({ sessions: [session, ...s.sessions] }))
  return { id, parked }
}
