/**
 * Transcript reconstruction and restart recovery
 * (docs/DISCUSSION_ROOMS.md, "Failures and interruption").
 */
import { rt } from './text'
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

/** What `appendToTranscript` needs to know about a journal, kept up to date. */
export type TranscriptIndex = {
  messageIds: Set<string>
  turnStarts: Set<string>
  /** Turn ids some message closes. */
  closed: Set<string>
  /** Turn-starts no message closes (shown as interrupted placeholders). */
  orphans: Set<string>
  lastSeq: number
}

export function indexJournal(journal: RoomJournalRecord[]): TranscriptIndex {
  const idx: TranscriptIndex = {
    messageIds: new Set(),
    turnStarts: new Set(),
    closed: new Set(),
    orphans: new Set(),
    lastSeq: 0,
  }
  for (const r of journal) {
    if (r.type === 'message') {
      idx.messageIds.add(r.message.id)
      if (r.message.turnId) idx.closed.add(r.message.turnId)
      idx.lastSeq = Math.max(idx.lastSeq, r.message.seq)
    } else idx.turnStarts.add(r.turnId)
  }
  for (const id of idx.turnStarts) if (!idx.closed.has(id)) idx.orphans.add(id)
  return idx
}

/**
 * The transcript after `record` is appended to the journal: the same result as
 * `messagesFromJournal` over the longer journal, without rebuilding it (a live
 * room appends a record per message, which made every append O(n)). Updates
 * `idx` in place. Null when the journal already holds the record.
 */
export function appendToTranscript(
  idx: TranscriptIndex,
  roomId: string,
  messages: RoomMessage[],
  record: RoomJournalRecord
): RoomMessage[] | null {
  if (record.type === 'turn-start') {
    if (idx.turnStarts.has(record.turnId)) return null
    idx.turnStarts.add(record.turnId)
    if (idx.closed.has(record.turnId)) return messages
    idx.orphans.add(record.turnId)
    return [...messages, interruptedMessageFor(roomId, record, idx.lastSeq + 0.5)]
  }
  const m = record.message
  if (idx.messageIds.has(m.id)) return null
  idx.messageIds.add(m.id)
  let next = messages
  if (m.turnId) {
    if (idx.orphans.delete(m.turnId)) {
      // The turn is closed now: its placeholder goes (an orphan's only
      // message with this id is the placeholder).
      const placeholder = interruptedMessageId(m.turnId)
      const at = next.findIndex((x) => x.id === placeholder && x.turnId === m.turnId)
      if (at !== -1) next = [...next.slice(0, at), ...next.slice(at + 1)]
    }
    idx.closed.add(m.turnId)
  }
  idx.lastSeq = Math.max(idx.lastSeq, m.seq)
  return [...next, m]
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
      // A room waiting for the user with no turn in flight was idle: a reload
      // interrupted nothing, so it stays as it was.
      if (room.status === 'awaiting-user' && unmatchedTurnStarts(journal).length === 0) continue
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
            text: rt('restarted'),
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
