import type { UIMessage } from 'ai'
import type { HandoffRecord } from '@/lib/sessionHandoff'
import type { ContinuityRecord } from '@/lib/coworkContinuity'
import type { CodePanelState } from '@/lib/coworkCode'
import type {
  CoworkTurn,
  SubagentRun,
  Usage,
  CoworkGoal,
  TodoList,
  CampaignLink,
} from '@/types/coworkSession'
import type { InFlightRecord, InterruptedChoice } from '@/lib/coworkInflight'
import type { CoworkMode } from '@/lib/coworkMode'
import type { AccessMode, EditConsent } from '@/lib/coworkAccess'
import type { QueuedMessageSender } from '@/stores/message-queue-store'
import type {
  ImportedFrom,
  ImportRefusal,
  SessionBundle,
} from '@/lib/sessionBundle'

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

export type CoworkSession = {
  id: string
  title: string
  /**
   * The user named this session (Rename). The automatic title (the prompt
   * placeholder, then the model's) never replaces a name the user gave.
   */
  titleManual?: boolean
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
  /**
   * Extra folders the user marked read-only. Absent or empty: every extra
   * folder follows the session's access, as before. The write grant leaves
   * these out, so the backend refuses writes there. Read through
   * `writableExtraFoldersOf`.
   */
  readOnlyExtraFolders?: string[]
  /**
   * Whether the user marked the main folder read-only, independently of the
   * extra folders. Absent: derived from `access` (read-only exactly under
   * Review only), so sessions saved before this need no migration. Read
   * through `mainFolderReadOnlyOf`.
   */
  mainFolderReadOnly?: boolean
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
  /**
   * The campaign this session coordinates or runs a task of. Provenance only;
   * absent on every ordinary session and on sessions saved before campaigns.
   */
  campaign?: CampaignLink
  /**
   * The server runs this session (`flint serve --agent-run`): its id is the
   * server's, and its transcript is read from there, never saved here.
   */
  remote?: boolean
  /** A server session's state as the server last reported it. */
  remoteStatus?: 'running' | 'idle' | 'awaiting_approval' | 'awaiting_answer'
  /** The model the server runs a server session with, as it reported it. */
  remoteModel?: string | null
  /** The access a server session runs with, as the server last reported it. */
  remoteAccess?: string
  updated: number
  /**
   * When the session was created (epoch millis). Absent on sessions saved
   * before it existed; the Agent Runs table falls back to the first timestamp
   * a turn carries, then to `updated`.
   */
  createdAt?: number
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
  /**
   * Set when `spawn_session` made this session (a nested chat), so a spawn
   * that copied the parent's turns (`context: 'fork'`) is still recognised
   * as one. Older spawns are marked by `turns === 0` instead.
   */
  spawned?: boolean
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

export type CoworkSessionsState = {
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
  /**
   * Remove a session. Its prompt snapshots and other records go too, unless
   * `keepRecords` says the session is only being archived (they are removed
   * when the archived session is finally deleted).
   */
  deleteSession: (id: string, opts?: { keepRecords?: boolean }) => void
  /** Put an archived session back; a session with that id already there wins. */
  restoreSession: (session: CoworkSession) => boolean
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
   * Create a session from the turns of a converted chat. Unbound like a fork:
   * no folder, no access, no grants. Returns the new session's id.
   */
  createFromTurns: (title: string, turns: CoworkTurn[]) => string
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
  /** Mark one extra folder editable or read-only; the grant is the caller's. */
  setExtraFolderWritable: (id: string, folder: string, writable: boolean) => void
  /**
   * Mark the main folder read-only or editable; undefined goes back to
   * deriving it from the access mode. The grant is the caller's.
   */
  setMainFolderReadOnly: (id: string, readOnly: boolean | undefined) => void
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
  /** The user's own name for the session; empty input is ignored. */
  renameSession: (id: string, title: string) => void
  setCampaign: (id: string, campaign: CampaignLink | null) => void
  setMessages: (id: string, messages: UIMessage[]) => void
  setGoal: (id: string, goal: CoworkGoal | null) => void
  setTodos: (id: string, todos: TodoList, anchorId?: string) => void
  setProgressUi: (id: string, patch: ProgressUi) => void
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
}
