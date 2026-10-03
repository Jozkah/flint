// The phase-3 RPC handlers: a phone acting on the computer. Each one decides
// what the desktop would do (queue while a run is going, send when idle, ...)
// and then calls `RemoteActions`, which the app implements with the very
// functions its own controls call (see `appActions.ts`). Tests supply mocks.

import type { Attachment } from '@/types/attachment'
import type { SubmittedFile } from '@/lib/coworkAttachments'
import type { PlannedAttachments } from './attachments'
import { RemoteRpcError, type RemoteHandlers } from './bridge'
import { createIdempotencyCache, type IdempotencyCache } from './idempotency'
import { checkAskAnswers } from './asks'
import { offers } from './prompts'
import type { AskAnswer } from '@/types/coworkSession'
import type {
  ApprovalRespondParams,
  AskRespondParams,
  PromptRespondParams,
  RemoteAsk,
  RemotePrompt,
  ChatSendParams,
  CoworkAccessId,
  CoworkModeId,
  CoworkSendParams,
  ModelRef,
  NotificationPrefs,
  ReasoningMode,
  RoomControlParams,
  RoomSendParams,
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
  createChat(input: { text: string; model?: ModelRef; files?: SubmittedFile[]; docs?: Attachment[] }): Promise<string>
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
  /** The desktop composer's busy path: queue, or steer (Ctrl+Enter). */
  enqueue(queueId: string, text: string, steer: boolean): void
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

const MAX_TEXT = 100_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function textOf(p: Record<string, unknown>, allowEmpty = false): string {
  const text = typeof p.text === 'string' ? p.text.trim() : ''
  if (!text && allowEmpty) return ''
  if (!text) throw new RemoteRpcError('bad_params', 'The message is empty')
  if (text.length > MAX_TEXT) throw new RemoteRpcError('bad_params', 'The message is too long')
  return text
}

const NO_ATTACHMENTS: PlannedAttachments = { files: [], docs: [], rejected: [] }

/** Upload ids named by a send: at most ten, each a hex id. */
function uploadIdsOf(p: Record<string, unknown>): string[] {
  const raw = p.attachments
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 10 || !raw.every((x) => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x))) {
    throw new RemoteRpcError('bad_params', 'attachments must be up to 10 upload ids')
  }
  return raw as string[]
}

function clientIdOf(p: Record<string, unknown>): string {
  const id = p.clientId
  if (typeof id !== 'string' || !/^[\w.:-]{6,80}$/.test(id)) {
    throw new RemoteRpcError('bad_params', 'clientId is required')
  }
  return id
}

function modelOf(v: unknown): ModelRef | undefined {
  if (!isRecord(v)) return undefined
  const id = str(v.id)
  const provider = str(v.provider)
  return id && provider ? { id, provider } : undefined
}

const REASONING: readonly ReasoningMode[] = ['auto', 'on', 'off']
const MODES: readonly CoworkModeId[] = ['review', 'ask', 'auto']
const ACCESS: readonly CoworkAccessId[] = ['review-only', 'managed-worktree', 'edit-folder']

const desktopOnly = (what: string) =>
  new RemoteRpcError('desktop_only', `${what} is done on the computer`)

const WIRE_DECISION = {
  once: 'allow-once',
  thread: 'allow-thread',
  always: 'allow-always',
  temporary: 'allow-git-temporary',
} as const

type ActionMethods =
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

export function createActionHandlers(
  a: RemoteActions,
  cache: IdempotencyCache = createIdempotencyCache()
): Pick<RemoteHandlers, ActionMethods> {
  /** Queue, steer or send, as the desktop composer does. */
  const deliver = async (
    kind: 'chat' | 'cowork',
    id: string,
    text: string,
    steer: boolean,
    busy: () => boolean,
    att: PlannedAttachments = NO_ATTACHMENTS
  ): Promise<SendResult> => {
    const attaching = att.files.length + att.docs.length > 0
    if (busy() && attaching) {
      throw new RemoteRpcError('busy', 'Wait for the reply to finish to send files')
    }
    if (busy()) {
      a.enqueue(id, text, steer)
      a.open(kind, id)
      return { kind, id, delivery: steer ? 'steered' : 'queued' }
    }
    a.open(kind, id)
    if (att.docs.length) a.stageDocs?.(id, att.docs)
    // The desktop may have started a run while the view mounted.
    const sent = att.files.length
      ? await a.sendViaComposer(kind, id, text, att.files)
      : await a.sendViaComposer(kind, id, text)
    if (!sent) {
      throw new RemoteRpcError('unavailable', "Flint's window didn't open that conversation in time")
    }
    return { kind, id, delivery: 'sent', ...(att.rejected.length ? { rejected: att.rejected } : {}) }
  }

  /** Uploads named by a send, or nothing. Every file refused and no text:
   * the send fails with the reasons. */
  const prepare = async (
    deviceId: string,
    target: { kind: 'chat' | 'cowork'; id: string | null; model?: ModelRef },
    p: Record<string, unknown>,
    text: string
  ): Promise<PlannedAttachments> => {
    const ids = uploadIdsOf(p)
    if (!ids.length) return NO_ATTACHMENTS
    if (!a.prepareAttachments) throw new RemoteRpcError('not_implemented', 'Attachments from phones are not available')
    const att = await a.prepareAttachments(deviceId, target, ids)
    const found = att.files.length + att.docs.length + att.rejected.length
    if (found < ids.length) {
      throw new RemoteRpcError('not_found', 'An attachment is gone; add it again')
    }
    if (!text && att.files.length + att.docs.length === 0) {
      throw new RemoteRpcError('rejected', att.rejected.map((r) => `${r.name}: ${r.message}`).join(' · '))
    }
    return att
  }
  /** A message action in a chat: only while it is idle, as on the desktop
   * (its row hides them during a reply). */
  const chatAct = async (id: string, action: Parameters<NonNullable<RemoteActions['chatAct']>>[1]) => {
    if (!a.chatAct) throw new RemoteRpcError('not_implemented', 'That is not available from phones yet')
    if (!a.chatExists(id)) throw new RemoteRpcError('not_found', 'No such chat')
    if (a.chatBusy(id)) throw new RemoteRpcError('busy', 'Wait for the reply to finish')
    a.open('chat', id)
    if (!(await a.chatAct(id, action))) {
      throw new RemoteRpcError('unavailable', "Flint's window didn't open that chat in time")
    }
  }
  const textWith = (text: string, att: PlannedAttachments) =>
    text || (att.files.length + att.docs.length ? 'Please look at the attached file(s).' : text)

  return {
    'chat.send': (params, ctx) => {
      const p = (isRecord(params) ? params : {}) as Partial<ChatSendParams> & Record<string, unknown>
      const clientId = clientIdOf(p)
      const text = textOf(p, uploadIdsOf(p).length > 0)
      const id = str(p.id)
      const isNew = p.new === true || !id
      if (!isNew && !a.chatExists(id)) throw new RemoteRpcError('not_found', 'No such chat')
      const reasoning = REASONING.includes(p.reasoning as ReasoningMode) ? (p.reasoning as ReasoningMode) : undefined
      const model = modelOf(p.model)
      return cache.once(`${ctx.device.id}:chat:${clientId}`, async () => {
        if (typeof p.webSearch === 'boolean') a.setWebSearch(p.webSearch)
        const att = await prepare(ctx.device.id, { kind: 'chat', id: isNew ? null : id, model }, p, text)
        if (isNew) {
          if (reasoning) a.setChatReasoning(null, reasoning, model)
          const newId = await a.createChat({
            text: textWith(text, att),
            model,
            ...(att.files.length ? { files: att.files } : {}),
            ...(att.docs.length ? { docs: att.docs } : {}),
          })
          return { kind: 'chat', id: newId, delivery: 'sent', ...(att.rejected.length ? { rejected: att.rejected } : {}) } satisfies SendResult
        }
        if (reasoning) a.setChatReasoning(id, reasoning)
        return deliver('chat', id, textWith(text, att), p.steer === true, () => a.chatBusy(id), att)
      })
    },

    'cowork.send': (params, ctx) => {
      const p = (isRecord(params) ? params : {}) as Partial<CoworkSendParams> & Record<string, unknown>
      const clientId = clientIdOf(p)
      const text = textOf(p, uploadIdsOf(p).length > 0)
      const id = str(p.id)
      const isNew = p.new === true || !id
      if (!isNew && !a.coworkExists(id)) throw new RemoteRpcError('not_found', 'No such session')
      const mode = MODES.includes(p.mode as CoworkModeId) ? (p.mode as CoworkModeId) : undefined
      const access = ACCESS.includes(p.access as CoworkAccessId) ? (p.access as CoworkAccessId) : undefined
      const folder = str(p.folder)
      if (isNew && access && access !== 'review-only') {
        throw desktopOnly('Letting a session write to a worktree or the folder')
      }
      if (folder && !a.knownFolders().includes(folder)) {
        throw new RemoteRpcError('bad_params', 'Choose a folder the computer already uses; new folders are added on the computer')
      }
      const model = modelOf(p.model)
      return cache.once(`${ctx.device.id}:cowork:${clientId}`, async () => {
        const att = await prepare(ctx.device.id, { kind: 'cowork', id: isNew ? null : id, model }, p, text)
        const sid = isNew ? a.createCowork({ folder, mode, model }) : id
        if (!isNew && mode) a.setCoworkMode(sid, mode)
        if (!isNew && p.resume === true && !a.coworkBusy(sid)) a.recoverInterrupted?.(sid)
        return deliver('cowork', sid, textWith(text, att), p.steer === true, () => a.coworkBusy(sid), att)
      })
    },

    'run.stop': async (params) => {
      const p = (isRecord(params) ? params : {}) as Record<string, unknown>
      if (p.all === true) return { stopped: await a.stopAll() }
      const kind = p.kind as SessionKind
      const id = str(p.id)
      if (!id || !['chat', 'cowork', 'room'].includes(kind)) {
        throw new RemoteRpcError('bad_params', 'kind and id are required')
      }
      if (p.scope === 'chat') {
        if (!a.stopConversation) throw new RemoteRpcError('not_implemented', 'Stopping a whole chat is not available from phones yet')
        return { stopped: await a.stopConversation(kind, id) }
      }
      return { stopped: (await a.stop(kind, id)) ? 1 : 0 }
    },

    'approvals.respond': async (params) => {
      const p = (isRecord(params) ? params : {}) as Partial<ApprovalRespondParams>
      const requestId = str(p.requestId)
      if (!requestId || (p.decision !== 'allow' && p.decision !== 'deny')) {
        throw new RemoteRpcError('bad_params', 'requestId and decision are required')
      }
      const scope = p.scope ?? 'once'
      if (!(scope in WIRE_DECISION)) throw new RemoteRpcError('bad_params', 'Unknown scope')
      // The server already refused these; the window checks again, since it
      // is the one that records the grant.
      const perms = await a.permissions()
      if (perms && !perms.approvals) {
        throw new RemoteRpcError('forbidden', 'Approvals from phones are turned off on the computer')
      }
      if (p.decision === 'allow' && scope === 'always' && !perms?.alwaysAllow) {
        throw new RemoteRpcError('forbidden', '"Always allow" from phones is turned off on the computer')
      }
      const pending = a.findApproval(requestId)
      if (!pending) return { status: 'gone' }
      if (p.decision === 'allow' && !pending.scopes.includes(scope)) {
        throw new RemoteRpcError('bad_params', 'That permission is not offered for this request')
      }
      a.resolveApproval(
        pending.toolCallId,
        requestId,
        p.decision === 'deny' ? 'deny' : WIRE_DECISION[scope]
      )
      return { status: 'answered' }
    },

    'asks.respond': (params) => {
      const p = (isRecord(params) ? params : {}) as Partial<AskRespondParams>
      const requestId = str(p.requestId)
      const threadId = str(p.threadId)
      if (!requestId || !threadId) throw new RemoteRpcError('bad_params', 'requestId and threadId are required')
      if (!a.findAsk || !a.answerAsk) {
        throw new RemoteRpcError('not_implemented', 'Answering questions is not available from phones yet')
      }
      const ask = a.findAsk(threadId, requestId)
      if (!ask) return { status: 'gone' }
      let answers: AskAnswer[] | null = null
      if (p.answers !== null && p.answers !== undefined) {
        const checked = checkAskAnswers(ask, p.answers)
        if (typeof checked === 'string') throw new RemoteRpcError('bad_params', checked)
        answers = checked
      }
      return { status: a.answerAsk(threadId, requestId, answers) ? 'answered' : 'gone' }
    },

    'chat.regenerate': async (params) => {
      const p = (isRecord(params) ? params : {}) as Record<string, unknown>
      const id = str(p.id)
      if (!id) throw new RemoteRpcError('bad_params', 'id is required')
      await chatAct(id, { type: 'regenerate', ...(str(p.messageId) ? { messageId: str(p.messageId) } : {}) })
      return { ok: true }
    },

    'chat.edit': async (params) => {
      const p = (isRecord(params) ? params : {}) as Record<string, unknown>
      const id = str(p.id)
      const messageId = str(p.messageId)
      if (!id || !messageId) throw new RemoteRpcError('bad_params', 'id and messageId are required')
      await chatAct(id, { type: 'edit', messageId, text: textOf(p) })
      return { ok: true }
    },

    'approvals.prompt': async (params) => {
      const p = (isRecord(params) ? params : {}) as Partial<PromptRespondParams>
      const id = str(p.id)
      if (!id || typeof p.action !== 'string') throw new RemoteRpcError('bad_params', 'id and action are required')
      if (!a.findPrompt || !a.respondPrompt) {
        throw new RemoteRpcError('not_implemented', 'Answering this is not available from phones yet')
      }
      // The server already refused it when approvals from phones are off; the
      // window checks again, since it is the one that acts.
      const perms = await a.permissions()
      if (perms && !perms.approvals) {
        throw new RemoteRpcError('forbidden', 'Approvals from phones are turned off on the computer')
      }
      const prompt = a.findPrompt(id)
      if (!prompt) return { status: 'gone' }
      if (!offers(prompt, p.action)) throw new RemoteRpcError('bad_params', 'That answer is not offered for this prompt')
      return { status: a.respondPrompt(id, p.action) ? 'answered' : 'gone' }
    },

    'room.send': async (params, ctx) => {
      const p = (isRecord(params) ? params : {}) as Partial<RoomSendParams> & Record<string, unknown>
      const clientId = clientIdOf(p)
      const text = textOf(p)
      const id = str(p.id)
      if (!id) throw new RemoteRpcError('bad_params', 'id is required')
      if (!(await a.roomExists(id))) throw new RemoteRpcError('not_found', 'No such room')
      const to: RoomAddress =
        !p.to || p.to === 'everyone'
          ? { kind: 'room' }
          : p.to === 'moderator'
            ? { kind: 'moderator' }
            : { kind: 'participant', participantId: String(p.to) }
      return cache.once(`${ctx.device.id}:room:${clientId}`, async () => {
        a.open('room', id)
        await a.room.send(id, text, to)
        return { kind: 'room', id, delivery: 'sent' } satisfies SendResult
      })
    },

    'room.control': async (params) => {
      const p = (isRecord(params) ? params : {}) as Partial<RoomControlParams>
      const id = str(p.id)
      if (!id) throw new RemoteRpcError('bad_params', 'id is required')
      if (!(await a.roomExists(id))) throw new RemoteRpcError('not_found', 'No such room')
      a.open('room', id)
      switch (p.action) {
        case 'start':
          await a.room.start(id)
          break
        case 'pause':
          await a.room.pause(id)
          break
        case 'resume':
          await a.room.resume(id)
          break
        case 'stop':
          await a.room.stop(id)
          break
        case 'cancel':
          await a.room.cancelTurn(id)
          break
        case 'next': {
          const who = str(p.participantId)
          if (!who) throw new RemoteRpcError('bad_params', 'participantId is required')
          await a.room.selectNext(id, who)
          break
        }
        case 'vote': {
          const proposal = typeof p.proposal === 'string' ? p.proposal.trim() : ''
          if (!proposal) throw new RemoteRpcError('bad_params', 'The proposal is empty')
          await a.room.callVote(id, proposal)
          break
        }
        case 'synthesize':
          await a.room.synthesize(id)
          break
        case 'final':
          await a.room.requestFinalPositions(id)
          break
        default:
          throw new RemoteRpcError('bad_params', 'Unknown room action')
      }
      return { ok: true }
    },

    'settings.set': async (params, ctx) => {
      const p = (isRecord(params) ? params : {}) as Record<string, unknown>
      if (p.key === 'webSearch') {
        if (typeof p.value !== 'boolean') throw new RemoteRpcError('bad_params', 'value must be true or false')
        a.setWebSearch(p.value)
        return { ok: true }
      }
      if (p.key === 'notifications') {
        const v = isRecord(p.value) ? p.value : null
        const keys = ['approvals', 'runFinished', 'roomTurns', 'errors'] as const
        if (!v || !keys.every((k) => typeof v[k] === 'boolean')) {
          throw new RemoteRpcError('bad_params', 'Notification settings are incomplete')
        }
        a.setNotificationPrefs(ctx.device.id, v as NotificationPrefs)
        return { ok: true }
      }
      const id = str(p.id)
      if (p.scope === 'chat' && id) {
        if (!a.chatExists(id)) throw new RemoteRpcError('not_found', 'No such chat')
        const model = modelOf(p.model)
        if (model) a.setChatModel(id, model)
        if (REASONING.includes(p.reasoning as ReasoningMode)) a.setChatReasoning(id, p.reasoning as ReasoningMode)
        return { ok: true }
      }
      if (p.scope === 'cowork' && id) {
        if (!a.coworkExists(id)) throw new RemoteRpcError('not_found', 'No such session')
        if (p.access !== undefined) {
          if (!ACCESS.includes(p.access as CoworkAccessId)) throw new RemoteRpcError('bad_params', 'Unknown access')
          if (p.access !== 'review-only') throw desktopOnly('Letting a session write to a worktree or the folder')
          if (a.coworkAccess(id) !== 'review-only') await a.setCoworkReviewOnly(id)
        }
        if (p.mode !== undefined) {
          if (!MODES.includes(p.mode as CoworkModeId)) throw new RemoteRpcError('bad_params', 'Unknown mode')
          a.setCoworkMode(id, p.mode as CoworkModeId)
        }
        const model = modelOf(p.model)
        if (model) a.setCoworkModel(id, model)
        return { ok: true }
      }
      throw desktopOnly('That setting')
    },
  }
}
