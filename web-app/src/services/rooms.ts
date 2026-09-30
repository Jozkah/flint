/**
 * Typed wrappers over the discussion-room Tauri commands
 * (`src-tauri/src/core/rooms`, docs/DISCUSSION_ROOMS.md "Persistence").
 *
 * Every wrapper rejects with a `RoomError` (`{ code, message }`), whatever
 * shape the underlying invoke rejection had.
 */
import { invoke } from '@tauri-apps/api/core'
import type {
  Room,
  RoomError,
  RoomErrorCode,
  RoomJournalRecord,
  RoomSummary,
} from '@/lib/rooms/types'

export type RoomWithJournal = { room: Room; journal: RoomJournalRecord[] }

const ROOM_ERROR_CODES: Record<RoomErrorCode, true> = {
  not_found: true,
  invalid_id: true,
  invalid_room: true,
  stale_revision: true,
  too_large: true,
  io: true,
  unknown: true,
}

export function isRoomErrorCode(value: unknown): value is RoomErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(ROOM_ERROR_CODES, value)
  )
}

/** `code: message`, `code message` or a bare `code` at the start of a string. */
const CODE_PREFIX = /^([a-z_]+)(?:\s*:\s*|\s+|$)([\s\S]*)$/

function fromText(text: string): RoomError {
  const match = CODE_PREFIX.exec(text)
  if (match && isRoomErrorCode(match[1])) {
    return { code: match[1], message: match[2] || text }
  }
  return { code: 'unknown', message: text }
}

function describe(value: unknown): string {
  if (value === undefined) return 'unknown error'
  try {
    const json = JSON.stringify(value)
    if (typeof json === 'string') return json
  } catch {
    // fall through
  }
  return String(value)
}

/** Normalises anything a room command can reject with into a `RoomError`. */
export function toRoomError(error: unknown): RoomError {
  if (error !== null && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown }
    if (isRoomErrorCode(code)) {
      return {
        code,
        message: typeof message === 'string' && message ? message : code,
      }
    }
    if (typeof message === 'string') return fromText(message)
  }
  if (typeof error === 'string') return fromText(error)
  return { code: 'unknown', message: describe(error) }
}

async function call<T>(
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw toRoomError(error)
  }
}

/** Newest `updatedAt` first; unreadable rooms are skipped by the backend. */
export function listRooms(): Promise<RoomSummary[]> {
  return call<RoomSummary[]>('rooms_list', {})
}

export function getRoom(roomId: string): Promise<RoomWithJournal> {
  return call<RoomWithJournal>('room_get', { roomId })
}

/**
 * Saves with an optimistic revision check. Pass the `rev` last returned (0 for
 * a new room); resolves with the stored room (`rev + 1`, fresh `updatedAt`).
 */
export function saveRoom(room: Room): Promise<Room> {
  return call<Room>('room_save', { room })
}

/** Resolves with the stored record (`seq` assigned for messages). */
export function appendRoomRecord(
  roomId: string,
  record: RoomJournalRecord
): Promise<RoomJournalRecord> {
  return call<RoomJournalRecord>('room_append', { roomId, record })
}

/** Empty a room's journal; the room and its settings stay. */
export async function clearRoomJournal(roomId: string): Promise<void> {
  await call<null>('room_clear_journal', { roomId })
}

export async function deleteRoom(roomId: string): Promise<void> {
  await call<null>('room_delete', { roomId })
}
