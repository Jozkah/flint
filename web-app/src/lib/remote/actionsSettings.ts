// The settings a phone may change.

import { RemoteRpcError, type RemoteHandlers } from './bridge'
import type { CoworkAccessId, CoworkModeId, NotificationPrefs, ReasoningMode } from './protocol'
import type { ActionContext } from './actionTypes'
import { isRecord, str, modelOf, REASONING, MODES, ACCESS, desktopOnly } from './actionParams'

/** Settings a phone may change. */
export function settingsHandlers(ctx: ActionContext): Pick<RemoteHandlers, 'settings.set'> {
  const { a, checkMode } = ctx
  return {
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
          await checkMode(p.mode as CoworkModeId)
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
