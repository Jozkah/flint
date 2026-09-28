// Small calls several screens make: room controls and notification defaults.
import type { NotificationPrefs } from '@/lib/remote/protocol'
import { act, closeSheet } from './app'
import { invalidate } from './rpc'

export const DEFAULT_NOTIFY: NotificationPrefs = { approvals: true, runFinished: true, roomTurns: true, errors: true }

/** A room control, as the desktop's room toolbar calls it. */
export function roomAct(props: { id?: unknown }, action: 'pause' | 'resume' | 'stop' | 'cancel' | 'synthesize' | 'final' | 'start', done: string) {
  const id = typeof props.id === 'string' ? props.id : undefined
  if (!id) return
  closeSheet()
  void act('room.control', { id, action }, done).then(() => invalidate(['rooms.get', 'sessions.list']))
}
