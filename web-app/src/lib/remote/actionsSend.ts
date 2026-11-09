// The send handlers a phone calls: new messages, regenerating and editing.

import { RemoteRpcError, type RemoteHandlers } from './bridge'
import type {
  ChatSendParams,
  CoworkAccessId,
  CoworkModeId,
  CoworkSendParams,
  ReasoningMode,
  RoomSendParams,
  SendResult,
} from './protocol'
import type { RoomAddress, ActionContext } from './actionTypes'
import {
  isRecord,
  str,
  textOf,
  uploadIdsOf,
  clientIdOf,
  modelOf,
  REASONING,
  MODES,
  ACCESS,
  desktopOnly,
} from './actionParams'

/** Sending: new messages, regenerating and editing. */
export function sendHandlers(ctx: ActionContext): Pick<RemoteHandlers, 'chat.send' | 'cowork.send' | 'room.send' | 'chat.regenerate' | 'chat.edit'> {
  const { a, cache, deliver, prepare, chatAct, checkMode, textWith } = ctx
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
          const newId = await a.createChat({
            text: textWith(text, att),
            model,
            ...(reasoning ? { reasoning } : {}),
            ...(att.files.length ? { files: att.files } : {}),
            ...(att.docs.length ? { docs: att.docs } : {}),
          })
          return { kind: 'chat', id: newId, delivery: 'sent', ...(att.rejected.length ? { rejected: att.rejected } : {}) } satisfies SendResult
        }
        if (reasoning) a.setChatReasoning(id, reasoning)
        return deliver('chat', id, textWith(text, att), p.steer === true, () => a.chatBusy(id), att)
      })
    },
    'cowork.send': async (params, ctx) => {
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
      await checkMode(mode)
      const model = modelOf(p.model)
      return cache.once(`${ctx.device.id}:cowork:${clientId}`, async () => {
        const att = await prepare(ctx.device.id, { kind: 'cowork', id: isNew ? null : id, model }, p, text)
        const sid = isNew ? a.createCowork({ folder, mode, model }) : id
        if (!isNew && mode) a.setCoworkMode(sid, mode)
        if (!isNew && p.resume === true && !a.coworkBusy(sid)) a.recoverInterrupted?.(sid)
        return deliver('cowork', sid, textWith(text, att), p.steer === true, () => a.coworkBusy(sid), att)
      })
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
  }
}
