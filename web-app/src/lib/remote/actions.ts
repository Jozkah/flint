// The phase-3 RPC handlers: a phone acting on the computer. Each one decides
// what the desktop would do (queue while a run is going, send when idle, ...)
// and then calls `RemoteActions`, which the app implements with the very
// functions its own controls call (see `appActions.ts`). Tests supply mocks.

import { RemoteRpcError, type RemoteHandlers } from './bridge'
import { createIdempotencyCache, type IdempotencyCache } from './idempotency'
import type {
  ApprovalRespondParams,
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

export type ApprovalScopeWire = 'once' | 'thread' | 'always'

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
  createChat(input: { text: string; model?: ModelRef }): Promise<string>
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
  sendViaComposer(kind: 'chat' | 'cowork', id: string, text: string): Promise<boolean>
  /** The desktop composer's busy path: queue, or steer (Ctrl+Enter). */
  enqueue(queueId: string, text: string, steer: boolean): void
  /** Stop current task, as the desktop's Stop does. Returns whether a run
   * was reached. */
  stop(kind: SessionKind, id: string): Promise<boolean>
  /** "Stop all activity"; how many runs it reached. */
  stopAll(): Promise<number>

  // -- Approvals -------------------------------------------------------------
  /** A waiting prompt, with the scopes its card offers. */
  findApproval(requestId: string): { toolCallId: string; scopes: ApprovalScopeWire[] } | null
  resolveApproval(
    toolCallId: string,
    requestId: string,
    decision: 'allow-once' | 'allow-thread' | 'allow-always' | 'deny'
  ): void
  /** Settings › Remote access, as the window reads it. */
  permissions(): Promise<{ approvals: boolean; alwaysAllow: boolean } | null>

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

function textOf(p: Record<string, unknown>): string {
  const text = typeof p.text === 'string' ? p.text.trim() : ''
  if (!text) throw new RemoteRpcError('bad_params', 'The message is empty')
  if (text.length > MAX_TEXT) throw new RemoteRpcError('bad_params', 'The message is too long')
  return text
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
} as const

type ActionMethods =
  | 'chat.send'
  | 'cowork.send'
  | 'run.stop'
  | 'room.send'
  | 'room.control'
  | 'settings.set'
  | 'approvals.respond'

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
    busy: () => boolean
  ): Promise<SendResult> => {
    if (busy()) {
      a.enqueue(id, text, steer)
      a.open(kind, id)
      return { kind, id, delivery: steer ? 'steered' : 'queued' }
    }
    a.open(kind, id)
    // The desktop may have started a run while the view mounted.
    const sent = await a.sendViaComposer(kind, id, text)
    if (!sent) {
      throw new RemoteRpcError('unavailable', "Flint's window didn't open that conversation in time")
    }
    return { kind, id, delivery: 'sent' }
  }

  return {
    'chat.send': (params, ctx) => {
      const p = (isRecord(params) ? params : {}) as Partial<ChatSendParams> & Record<string, unknown>
      const clientId = clientIdOf(p)
      const text = textOf(p)
      const id = str(p.id)
      const isNew = p.new === true || !id
      if (!isNew && !a.chatExists(id)) throw new RemoteRpcError('not_found', 'No such chat')
      const reasoning = REASONING.includes(p.reasoning as ReasoningMode) ? (p.reasoning as ReasoningMode) : undefined
      const model = modelOf(p.model)
      return cache.once(`${ctx.device.id}:chat:${clientId}`, async () => {
        if (typeof p.webSearch === 'boolean') a.setWebSearch(p.webSearch)
        if (isNew) {
          if (reasoning) a.setChatReasoning(null, reasoning, model)
          const newId = await a.createChat({ text, model })
          return { kind: 'chat', id: newId, delivery: 'sent' } satisfies SendResult
        }
        if (reasoning) a.setChatReasoning(id, reasoning)
        return deliver('chat', id, text, p.steer === true, () => a.chatBusy(id))
      })
    },

    'cowork.send': (params, ctx) => {
      const p = (isRecord(params) ? params : {}) as Partial<CoworkSendParams> & Record<string, unknown>
      const clientId = clientIdOf(p)
      const text = textOf(p)
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
        const sid = isNew ? a.createCowork({ folder, mode, model }) : id
        if (!isNew && mode) a.setCoworkMode(sid, mode)
        return deliver('cowork', sid, text, p.steer === true, () => a.coworkBusy(sid))
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
