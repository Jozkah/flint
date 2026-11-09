// The remote-access wire protocol: acting on the computer (sending, stopping,
// approvals, settings). Re-exported by protocol.ts; free of app imports.

import type { SessionKind, RemoteToolStep, RoomDetail, CoworkDetail } from './protocolTypes'
import type { StudioItemWire } from './protocolStudio'

// ---------------------------------------------------------------------------
// Acting on the computer (phase 3)
// ---------------------------------------------------------------------------

export type ModelRef = { id: string; provider: string }
export type ReasoningMode = 'auto' | 'on' | 'off'
export type CoworkModeId = CoworkDetail['mode']
export type CoworkAccessId = CoworkDetail['access']

export type RoomCreateParticipant = {
  name: string
  role: string
  model: ModelRef
  toolAccess: 'none' | 'read' | 'edit' | 'full'
  reasoning?: { mode?: ReasoningMode; level?: string }
}
export type RoomCreateParams = {
  title: string
  objective?: string
  mode?: RoomDetail['mode']
  participants: RoomCreateParticipant[]
  moderator?: { enabled: boolean; name?: string; model?: ModelRef }
}
export type RoomUpdateParams = {
  id: string
  patch: {
    title?: string
    objective?: string
    mode?: RoomDetail['mode']
    participants?: Array<{ id: string; model?: ModelRef; reasoning?: { mode?: ReasoningMode; level?: string } }>
    moderator?: { enabled?: boolean; name?: string; model?: ModelRef }
    limits?: Partial<RoomDetail['limits']>
  }
}
export type RoomMutationResult = { ok: true; id: string }

/** Every send carries a `clientId` the phone makes once per message: a retry
 * after a dropped connection sends the same one, and the computer answers it
 * with the first result instead of sending twice. */
/** A file the desktop would not attach, with the composer's reason. */
export type AttachmentRejection = { name: string; reason: string; message: string }

export type ChatSendParams = {
  clientId: string
  text: string
  /** Finished uploads (`/remote/v1/upload`) to attach, by id. */
  attachments?: string[]
  /** An existing chat; omitted (or `new: true`) starts one. */
  id?: string
  new?: boolean
  /** New chats only: the model to start with. */
  model?: ModelRef
  /** The composer's toggles, applied as the desktop composer applies them. */
  webSearch?: boolean
  reasoning?: ReasoningMode
  /** While a run is going: hand it to the run at its next safe point
   * (the desktop's Ctrl+Enter) instead of queueing it. */
  steer?: boolean
}

export type CoworkSendParams = {
  clientId: string
  text: string
  attachments?: string[]
  id?: string
  new?: boolean
  /** New sessions: a folder the desktop already knows (recent folders). */
  folder?: string
  mode?: CoworkModeId
  /** Only `review-only` can be chosen from a phone; the others need the
   * desktop's own consent dialog. */
  access?: CoworkAccessId
  model?: ModelRef
  steer?: boolean
  /** Carry on a run that stopped (the desktop's "Keep going"); an
   * interrupted turn's finished steps are kept first. */
  resume?: boolean
}

export type RoomSendParams = {
  clientId: string
  id: string
  text: string
  /** A participant id, `moderator`, or null/omitted for everyone. */
  to?: string | null
}

export type SendResult = {
  kind: SessionKind
  /** The conversation it went to (new for a new chat or session). */
  id: string
  /** `sent`: a run started with it. `queued`: a run was going, so it waits
   * its turn, as on the desktop. `steered`: handed to the running turn. */
  delivery: 'sent' | 'queued' | 'steered'
  /** The same `clientId` was seen before; this is the first answer again. */
  duplicate?: boolean
  /** Attachments the desktop refused; the rest went with the message. */
  rejected?: AttachmentRejection[]
}

/** `scope: 'chat'` is the desktop's "Stop all in this chat" (#33): every run,
 * tool, command and agent under the conversation. */
export type RunStopParams =
  | { kind: SessionKind; id: string; all?: false; scope?: 'task' | 'chat' }
  | { all: true }
export type RunStopResult = { stopped: number }

export type RoomControlParams = {
  id: string
  action: 'start' | 'pause' | 'resume' | 'stop' | 'cancel' | 'next' | 'vote' | 'synthesize' | 'final'
  /** `next`: who speaks next. */
  participantId?: string
  /** `vote`: what to vote on. */
  proposal?: string
}

export type ApprovalRespondParams = {
  requestId: string
  decision: 'allow' | 'deny'
  /** `temporary`: the desktop's "Allow all temporarily" for routine Git
   * remote operations in this conversation (#45), offered only when the
   * approval lists it. */
  scope?: 'once' | 'thread' | 'always' | 'temporary'
}
/** `gone`: nothing waits under that id any more -- it was answered on the
 * computer (or another phone), or its run ended. */
export type ApprovalRespondResult = { status: 'answered' | 'gone' }

export type RemoteAskQuestion = {
  id: string
  question: string
  options: { label: string; description?: string }[]
  /** Several options may be chosen. */
  multi?: boolean
  /** Index of the option the model recommends. */
  recommended?: number
}
/** A question a Cowork run is waiting on (its `ask` tool): one or more
 * multiple-choice questions, answered together. Plan review and the opening
 * "continue?" proposal are questions too. */
export type RemoteAsk = {
  requestId: string
  /** The Cowork session that asked. */
  threadId: string
  questions: RemoteAskQuestion[]
  /** The staged plan, under a plan-review question. */
  plan?: { name: string; tasks: { content: string; done: boolean }[] }[]
  requestedAt?: number
}
export type AsksListResult = { asks: RemoteAsk[] }
/** One answer per question: option labels, or the user's own words. */
export type RemoteAskAnswer = { id: string; selected: string[]; custom_input?: string }
export type AskRespondParams = {
  requestId: string
  threadId: string
  /** `null` skips the question: the run is told nothing was chosen. */
  answers: RemoteAskAnswer[] | null
}
export type AskRespondResult = { status: 'answered' | 'gone' }

/** One of the desktop's other blocking prompts (a folder outside the
 * workspace, a site for the assistant's browser, overlapping team tasks, a
 * local model out of context), with the answers a phone may give. */
export type RemotePrompt = {
  id: string
  kind: 'access' | 'domain' | 'conflict' | 'context'
  /** The conversation that waits on it, when it belongs to one. */
  threadId?: string
  title: string
  body?: string
  /** The path, address or files it is about. */
  detail?: string
  /** Who is asking, when it is a subagent or a team child. */
  origin?: string
  actions: { id: string; label: string; style?: 'primary' | 'danger' }[]
}
export type PromptsListResult = { prompts: RemotePrompt[] }
export type PromptRespondParams = { id: string; action: string }
export type PromptRespondResult = { status: 'answered' | 'gone' }

export type NotificationPrefs = {
  approvals: boolean
  runFinished: boolean
  roomTurns: boolean
  errors: boolean
}

export type SettingsSetParams =
  | { key: 'webSearch'; value: boolean }
  | { key: 'notifications'; value: NotificationPrefs }
  | { scope: 'chat'; id: string; reasoning?: ReasoningMode; model?: ModelRef }
  | {
      scope: 'cowork'
      id: string
      mode?: CoworkModeId
      access?: CoworkAccessId
      model?: ModelRef
    }

/** The reply being written in a conversation right now, for a phone that
 * (re)opens it mid-run. */
export type StreamGetParams = { kind: SessionKind; id: string }
export type StreamSnapshot = {
  kind: SessionKind
  id: string
  messageId: string
  text: string
  reasoning: string
  tools: RemoteToolStep[]
  /** Room: who is speaking. */
  author?: string
}

export type QueuedItem = {
  id: string
  text: string
  /** Goes to the running turn at its next safe point. */
  steer: boolean
  /** Waits for the user to send or discard it (after a stop or a restart). */
  held: boolean
  /** Mail from another session: its name. */
  from?: string
}
export type QueueResult = { items: QueuedItem[] }

export type ChangedFile = {
  path: string
  additions: number
  deletions: number
  /** Who wrote it: the run, a subagent (its name), or the user. */
  source: string
  /** Unified-diff text of each write, oldest first (capped). */
  hunks: string[]
}

export type RemotePr = {
  number: number
  title: string
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  checks: { passed: number; failed: number; pending: number }
  conflicts: boolean
}

export type CoworkChanges = {
  files: ChangedFile[]
  /** "3 files changed · +24 −8", once a run has finished; null otherwise. */
  summary: string | null
  /** Where the work happens: a managed worktree's branch and path. */
  worktree: { branch: string | null; path: string } | null
  pr: RemotePr | null
  /** Applying a copy's changes to the folder is done on the computer. */
  applyOnDesktop: boolean
}

export type CoworkActivity = {
  subagents: { id: string; name: string; status: 'queued' | 'running' | 'done'; startedAt: number; endedAt?: number; steps: number }[]
  commands: { id: string; command: string; status: RemoteToolStep['status'] }[]
}

export type LibraryItem = {
  path: string
  title: string
  group: string
  label: string
  sessionId: string
  sessionTitle: string
  updatedAt: number
  /** Set for a Studio result: its media loads with `studio.media`. */
  studio?: StudioItemWire
}
export type LibraryResult = { items: LibraryItem[] }
