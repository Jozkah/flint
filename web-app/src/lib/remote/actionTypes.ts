// What the phone's RPC handlers call on the desktop (`RemoteActions`), and
// what every handler group shares (`ActionContext`).

import type { Attachment } from '@/types/attachment'
import type { SubmittedFile } from '@/lib/coworkAttachments'
import type { PlannedAttachments } from './attachments'
import type { IdempotencyCache } from './idempotency'
import type { AskAnswer } from '@/types/coworkSession'
import type {
  RemoteAsk,
  RemotePrompt,
  CoworkAccessId,
  CoworkModeId,
  ModelRef,
  NotificationPrefs,
  ReasoningMode,
  SendResult,
  SessionKind,
} from './protocol'

export type ApprovalScopeWire = 'once' | 'thread' | 'always' | 'temporary'

export type RoomAddress =
  | { kind: 'room' }
  | { kind: 'participant'; participantId: string }
  | { kind: 'moderator' }

export type RemoteActions = {
  // -- Chat ------------------------------------------------------------------
  chatExists(id: string): boolean
  chatBusy(id: string): boolean
  /** The desktop composer's new-chat path: create the thread with `model`,
   * hand it the first message and open it. Returns the new id. */
  createChat(input: {
    text: string
    model?: ModelRef
    /** Applied to the model the chat ends up with, once that is resolved. */
    reasoning?: ReasoningMode
    files?: SubmittedFile[]
    docs?: Attachment[]
  }): Promise<string>
  setWebSearch(on: boolean): void
  /** The composer's Reasoning Auto/On/Off, for the chat's model. */
  setChatReasoning(chatId: string | null, mode: ReasoningMode, model?: ModelRef): void
  setChatModel(chatId: string, model: ModelRef): void

  // -- Cowork ----------------------------------------------------------------
  coworkExists(id: string): boolean
  coworkBusy(id: string): boolean
  /** Folders the desktop already knows; a phone cannot open a picker. */
  knownFolders(): string[]
  createCowork(input: { folder?: string; mode?: CoworkModeId; model?: ModelRef }): string
  setCoworkMode(id: string, mode: CoworkModeId): void
  setCoworkModel(id: string, model: ModelRef): void
  coworkAccess(id: string): CoworkAccessId | null
  /** Back to review-only (the desktop's "Return to review-only"). */
  setCoworkReviewOnly(id: string): Promise<void>

  // -- Both ------------------------------------------------------------------
  /** Brings the conversation into view on the desktop. */
  open(kind: SessionKind, id: string): void
  /** Sends through the conversation's own composer, once it is mounted.
   * False when it did not mount in time. */
  sendViaComposer(kind: 'chat' | 'cowork', id: string, text: string, files?: SubmittedFile[]): Promise<boolean>
  /** A phone's finished uploads, checked as the composer checks attachments
   * for the conversation's model. */
  prepareAttachments?(
    deviceId: string,
    target: { kind: 'chat' | 'cowork'; id: string | null; model?: ModelRef },
    uploadIds: string[]
  ): Promise<PlannedAttachments>
  /** Stages documents in the conversation's composer, read at send time. */
  stageDocs?(id: string, docs: Attachment[]): void
  /** The desktop composer's busy path: queue, or steer (Ctrl+Enter). A
   * message with attachments is queued (never steered) and sent with them. */
  enqueue(
    queueId: string,
    text: string,
    steer: boolean,
    attachments?: { files: SubmittedFile[]; docs: Attachment[] }
  ): void
  /** Stop current task, as the desktop's Stop does. Returns whether a run
   * was reached. */
  stop(kind: SessionKind, id: string): Promise<boolean>
  /** "Stop all activity"; how many runs it reached. */
  stopAll(): Promise<number>
  /** "Stop all in this chat" (#33): the conversation's run and everything
   * under it; how many processes it stopped. */
  stopConversation?(kind: SessionKind, id: string): Promise<number>

  // -- Approvals -------------------------------------------------------------
  /** A waiting prompt, with the scopes its card offers. */
  findApproval(requestId: string): { toolCallId: string; scopes: ApprovalScopeWire[] } | null
  resolveApproval(
    toolCallId: string,
    requestId: string,
    decision: 'allow-once' | 'allow-thread' | 'allow-always' | 'allow-git-temporary' | 'deny'
  ): void
  /** Settings › Remote access, as the window reads it. */
  permissions(): Promise<{ approvals: boolean; alwaysAllow: boolean } | null>

  // -- Questions -------------------------------------------------------------
  /** A question a Cowork run is waiting on. */
  findAsk?(threadId: string, requestId: string): RemoteAsk | null
  /** Hands the run its answer (`null`: skipped), as the desktop's card does.
   * False when nothing waits under that id any more. */
  answerAsk?(threadId: string, requestId: string, answers: AskAnswer[] | null): boolean
  /** One of the other blocking prompts (see `prompts.ts`). */
  findPrompt?(id: string): RemotePrompt | null
  /** Answers it as the desktop's own dialog would. False when it is gone. */
  respondPrompt?(id: string, action: string): boolean
  /** Keeps what an interrupted turn finished, so the session can go on. */
  recoverInterrupted?(id: string): void
  /** Regenerates or edits through the mounted chat's own handlers. False
   * when the chat did not mount in time. */
  chatAct?(
    id: string,
    action: { type: 'regenerate'; messageId?: string } | { type: 'edit'; messageId: string; text: string }
  ): Promise<boolean>

  // -- Rooms -----------------------------------------------------------------
  roomExists(id: string): Promise<boolean>
  room: {
    send(id: string, text: string, to: RoomAddress): Promise<void>
    start(id: string): Promise<void>
    pause(id: string): Promise<void>
    resume(id: string): Promise<void>
    stop(id: string): Promise<void>
    cancelTurn(id: string): Promise<void>
    selectNext(id: string, participantId: string): Promise<void>
    callVote(id: string, proposal: string): Promise<void>
    synthesize(id: string): Promise<void>
    requestFinalPositions(id: string): Promise<void>
  }

  // -- Settings --------------------------------------------------------------
  setNotificationPrefs(device: string, prefs: NotificationPrefs): void
}

export type ActionMethods =
  | 'chat.send'
  | 'cowork.send'
  | 'run.stop'
  | 'room.send'
  | 'room.control'
  | 'settings.set'
  | 'approvals.respond'
  | 'asks.respond'
  | 'approvals.prompt'
  | 'chat.regenerate'
  | 'chat.edit'

/** What every handler group shares: the desktop actions and the send helpers. */
export type ActionContext = {
  a: RemoteActions
  cache: IdempotencyCache
  deliver: (
    kind: 'chat' | 'cowork',
    id: string,
    text: string,
    steer: boolean,
    busy: () => boolean,
    att?: PlannedAttachments
  ) => Promise<SendResult>
  prepare: (
    deviceId: string,
    target: { kind: 'chat' | 'cowork'; id: string | null; model?: ModelRef },
    p: Record<string, unknown>,
    text: string
  ) => Promise<PlannedAttachments>
  chatAct: (id: string, action: Parameters<NonNullable<RemoteActions['chatAct']>>[1]) => Promise<void>
  checkMode: (mode: CoworkModeId | undefined) => Promise<void>
  textWith: (text: string, att: PlannedAttachments) => string
}
