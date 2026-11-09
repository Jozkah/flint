// The phase-3 RPC handlers: a phone acting on the computer. Each one decides
// what the desktop would do (queue while a run is going, send when idle, ...)
// and then calls `RemoteActions`, which the app implements with the very
// functions its own controls call (see `appActions.ts`). Tests supply mocks.

import type { PlannedAttachments } from './attachments'
import { RemoteRpcError, type RemoteHandlers } from './bridge'
import { createIdempotencyCache, type IdempotencyCache } from './idempotency'
import type { CoworkModeId, ModelRef, SendResult } from './protocol'
import type { RemoteActions, ActionMethods, ActionContext } from './actionTypes'
import { NO_ATTACHMENTS, uploadIdsOf, desktopOnly } from './actionParams'
import { sendHandlers } from './actionsSend'
import { controlHandlers } from './actionsControl'
import { approvalHandlers } from './actionsApprovals'
import { settingsHandlers } from './actionsSettings'

export type { ApprovalScopeWire, RoomAddress, RemoteActions } from './actionTypes'

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
      // Queued with its attachments and sent with them once the run ends.
      // The uploads are already taken on the desktop; refusing would make the
      // phone upload them again.
      a.enqueue(id, text, false, { files: att.files, docs: att.docs })
      a.open(kind, id)
      return { kind, id, delivery: 'queued', ...(att.rejected.length ? { rejected: att.rejected } : {}) }
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
  /**
   * A mode a phone may pick. `bypass` runs every tool without asking, so it is
   * set only on the computer; `auto` answers some approvals itself, so it needs
   * approvals from phones to be on.
   */
  const checkMode = async (mode: CoworkModeId | undefined) => {
    if (mode === 'bypass') throw desktopOnly('Bypassing approvals')
    if (mode === 'auto') {
      const perms = await a.permissions()
      if (!perms?.approvals) {
        throw new RemoteRpcError('forbidden', 'Approvals from phones are turned off on the computer')
      }
    }
  }
  const textWith = (text: string, att: PlannedAttachments) =>
    text || (att.files.length + att.docs.length ? 'Please look at the attached file(s).' : text)

  const ctx: ActionContext = { a, cache, deliver, prepare, chatAct, checkMode, textWith }
  return Object.assign(
    {},
    sendHandlers(ctx),
    controlHandlers(ctx),
    approvalHandlers(ctx),
    settingsHandlers(ctx)
  )
}
