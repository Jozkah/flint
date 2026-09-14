/**
 * Transcript reconstruction and restart recovery
 * (docs/DISCUSSION_ROOMS.md, "Failures and interruption").
 */
import { getRoomPersistence, type RoomPersistence } from './persistence'
import {
  ROOM_SCHEMA_VERSION,
  type RoomJournalRecord,
  type RoomMessage,
  type Room,
} from './types'

/** Deterministic id for the message that closes an orphaned turn-start. */
export function interruptedMessageId(turnId: string): string {
  return `${turnId}.interrupted`.slice(0, 128)
}

/** turn-start records that no message closes. */
export function unmatchedTurnStarts(
  journal: RoomJournalRecord[]
): Array<Extract<RoomJournalRecord, { type: 'turn-start' }>> {
  const closed = new Set<string>()
  for (const r of journal) {
    if (r.type === 'message' && r.message.turnId) closed.add(r.message.turnId)
  }
  return journal.filter(
    (r): r is Extract<RoomJournalRecord, { type: 'turn-start' }> =>
      r.type === 'turn-start' && !closed.has(r.turnId)
  )
}

export function interruptedMessageFor(
  roomId: string,
  start: Extract<RoomJournalRecord, { type: 'turn-start' }>,
  seq = 0
): RoomMessage {
  return {
    v: ROOM_SCHEMA_VERSION,
    id: interruptedMessageId(start.turnId),
    roomId,
    seq,
    turnId: start.turnId,
    author: start.speaker,
    to: { kind: 'room' },
    kind: start.speaker.kind === 'moderator' ? 'moderator-note' : 'speech',
    text: '',
    round: start.round,
    createdAt: start.at,
    status: 'interrupted',
  }
}

/**
 * Messages in transcript order. A turn-start without a matching message
 * (crash mid-turn) becomes an `interrupted` message with empty text, placed
 * where the turn began.
 */
export function messagesFromJournal(
  roomId: string,
  journal: RoomJournalRecord[]
): RoomMessage[] {
  const orphans = new Set(unmatchedTurnStarts(journal).map((r) => r.turnId))
  const out: RoomMessage[] = []
  let lastSeq = 0
  for (const r of journal) {
    if (r.type === 'message') {
      out.push(r.message)
      lastSeq = Math.max(lastSeq, r.message.seq)
    } else if (orphans.has(r.turnId)) {
      out.push(interruptedMessageFor(roomId, r, lastSeq + 0.5))
    }
  }
  return out
}

/** Append real interrupted messages for orphaned turn-starts (idempotent by id). */
export async function repairJournal(
  roomId: string,
  journal: RoomJournalRecord[],
  persistence: RoomPersistence
): Promise<RoomJournalRecord[]> {
  const repaired = [...journal]
  for (const start of unmatchedTurnStarts(journal)) {
    const stored = await persistence.appendRoomRecord(roomId, {
      type: 'message',
      message: interruptedMessageFor(roomId, start),
    })
    repaired.push(stored)
  }
  return repaired
}

/**
 * Startup hook for `hydrateBackendStores`: runs recovery only when `enabled`
 * (under Tauri) and never rejects.
 */
export async function scheduleRoomRecovery(
  enabled: boolean,
  run: () => Promise<unknown> = () => recoverRoomsOnLoad()
): Promise<void> {
  if (!enabled) return
  try {
    await run()
  } catch (e) {
    console.error('[rooms] restart recovery failed', e)
  }
}

function newRecoveryId(roomId: string, at: number): string {
  return `${roomId.slice(0, 80)}.restart.${at}`
}

/**
 * On app load: rooms left `running` or `awaiting-user` by the previous app run
 * are saved `paused` with `interrupted-by-restart`. Nothing resumes by itself.
 * Failures are logged per room, never thrown.
 */
export async function recoverRoomsOnLoad(
  persistence: RoomPersistence = getRoomPersistence(),
  now: () => number = Date.now
): Promise<string[]> {
  const recovered: string[] = []
  let summaries
  try {
    summaries = await persistence.listRooms()
  } catch (e) {
    console.warn('[rooms] recovery could not list rooms', e)
    return recovered
  }
  for (const s of summaries) {
    if (s.status !== 'running' && s.status !== 'awaiting-user') continue
    try {
      const { room, journal } = await persistence.getRoom(s.id)
      if (room.status !== 'running' && room.status !== 'awaiting-user') continue
      await repairJournal(room.id, journal, persistence)
      const at = now()
      if (room.status === 'running') {
        await persistence.appendRoomRecord(room.id, {
          type: 'message',
          message: {
            v: ROOM_SCHEMA_VERSION,
            id: newRecoveryId(room.id, at),
            roomId: room.id,
            seq: 0,
            turnId: null,
            author: { kind: 'system' },
            to: { kind: 'room' },
            kind: 'system',
            text: 'Flint restarted while this room was running. The room is paused.',
            round: room.round,
            createdAt: at,
            status: 'complete',
          },
        })
      }
      const paused: Room = {
        ...room,
        status: 'paused',
        stopReason: { kind: 'interrupted-by-restart' },
        updatedAt: at,
      }
      await persistence.saveRoom(paused)
      recovered.push(room.id)
    } catch (e) {
      console.warn(`[rooms] recovery failed for room ${s.id}`, e)
    }
  }
  return recovered
}
