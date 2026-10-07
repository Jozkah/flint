// Small calls several screens make: room controls and notification defaults.
import type { NotificationPrefs, SessionKind } from '@/lib/remote/protocol'
import { act, client, closeSheet, go, toast } from './app'
import { invalidate } from './rpc'
import { t } from '../i18n'

export const DEFAULT_NOTIFY: NotificationPrefs = { approvals: true, runFinished: true, roomTurns: true, errors: true }

/** A room control, as the desktop's room toolbar calls it. */
export function roomAct(props: { id?: unknown }, action: 'pause' | 'resume' | 'stop' | 'cancel' | 'synthesize' | 'final' | 'start', done: string) {
  const id = typeof props.id === 'string' ? props.id : undefined
  if (!id) return
  closeSheet()
  void act('room.control', { id, action }, done).then(() => invalidate(['rooms.get', 'sessions.list']))
}

/** "Fork chat from here" (#61): a new chat up to this message, opened. */
export async function forkFrom(id: string, messageId?: string) {
  try {
    const r = await client().rpc('chat.fork', { id, ...(messageId ? { messageId } : {}) })
    toast(t('controls.forked'))
    invalidate(['sessions.list'])
    go({ name: 'chat', id: r.id })
  } catch (e) {
    toast(e instanceof Error ? e.message : t('controls.forkFailed'))
  }
}

/** Step a message to its previous or next version; true when the chat moved. */
export async function stepVersion(id: string, messageId: string, dir: -1 | 1): Promise<boolean> {
  try {
    const { ok } = await client().rpc('thread.branch.select', { id, messageId, dir })
    if (!ok) toast(t('controls.waitThenRetry'))
    else invalidate(['thread.messages', 'chat.details', 'sessions.list'])
    return ok
  } catch (e) {
    toast(e instanceof Error ? e.message : t('controls.switchFailed'))
    return false
  }
}

/** Regenerate title, in the desktop's words for each result. */
export async function regenerateTitleOf(kind: SessionKind, id: string) {
  toast(t('controls.naming'))
  try {
    const { result } = await client().rpc('title.regenerate', { kind, id })
    toast(result === 'done' ? t('controls.titleUpdated') : result === 'empty' ? t('controls.nothingToName') : result === 'busy' ? t('controls.waitReply') : t('controls.titleFailed'))
    invalidate(['sessions.list', 'rooms.get', 'cowork.get'])
  } catch (e) {
    toast(e instanceof Error ? e.message : t('controls.titleFailed'))
  }
}
