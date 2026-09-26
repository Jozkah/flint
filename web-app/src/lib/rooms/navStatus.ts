import type { ThreadStatus } from '@/containers/ThreadStatusMark'
import type { RoomStatus } from './types'

/**
 * The sidebar mark for a room, by the same rules as Chat and Cowork: waiting
 * on the user (a pending tool approval for the room, or every participant
 * waiting on the user's reply or choice of speaker) takes precedence over
 * running.
 */
export function roomNavStatus({
  status,
  running,
  awaitingApproval,
}: {
  status: RoomStatus
  running: boolean
  awaitingApproval: boolean
}): ThreadStatus {
  if (awaitingApproval || status === 'awaiting-user') return 'wait'
  if (running) return 'active'
  return 'none'
}
