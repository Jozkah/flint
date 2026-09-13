/**
 * The persistence port used by the engine, store and controller.
 *
 * The default implementation lazily loads `@/services/rooms`, so importing the
 * engine does not pull in Tauri until a room is actually read or written.
 * Tests inject their own implementation with `setRoomPersistence`.
 */
import type {
  Room,
  RoomError,
  RoomErrorCode,
  RoomJournalRecord,
  RoomSummary,
} from './types'

export interface RoomPersistence {
  listRooms(): Promise<RoomSummary[]>
  getRoom(roomId: string): Promise<{ room: Room; journal: RoomJournalRecord[] }>
  saveRoom(room: Room): Promise<Room>
  appendRoomRecord(roomId: string, record: RoomJournalRecord): Promise<RoomJournalRecord>
  deleteRoom(roomId: string): Promise<void>
}

type RoomsServiceModule = RoomPersistence & { toRoomError?: (e: unknown) => RoomError }

async function loadService(): Promise<RoomsServiceModule> {
  return import('@/services/rooms')
}

export const defaultRoomPersistence: RoomPersistence = {
  listRooms: async () => (await loadService()).listRooms(),
  getRoom: async (roomId) => (await loadService()).getRoom(roomId),
  saveRoom: async (room) => (await loadService()).saveRoom(room),
  appendRoomRecord: async (roomId, record) =>
    (await loadService()).appendRoomRecord(roomId, record),
  deleteRoom: async (roomId) => {
    await (await loadService()).deleteRoom(roomId)
  },
}

let current: RoomPersistence | null = null

export function getRoomPersistence(): RoomPersistence {
  return current ?? defaultRoomPersistence
}

/** Replace the persistence port (tests); pass null to restore the default. */
export function setRoomPersistence(p: RoomPersistence | null): void {
  current = p
}

const CODES: RoomErrorCode[] = [
  'not_found',
  'invalid_id',
  'invalid_room',
  'stale_revision',
  'too_large',
  'io',
  'unknown',
]

/**
 * A failed room read or write, as thrown by the engine. Carries the backend's
 * `RoomErrorCode`, so it is never mistaken for a model-provider error: it is
 * not retried, not counted as a participant failure, and reported with its
 * own code.
 */
export class RoomPersistenceError extends Error {
  readonly code: RoomErrorCode
  constructor(error: RoomError) {
    super(error.message)
    this.name = 'RoomPersistenceError'
    this.code = error.code
  }
}

export function isRoomPersistenceError(e: unknown): e is RoomPersistenceError {
  return e instanceof RoomPersistenceError
}

/** Wrap anything a persistence call threw. */
export function toRoomPersistenceError(e: unknown): RoomPersistenceError {
  return e instanceof RoomPersistenceError ? e : new RoomPersistenceError(normaliseRoomError(e))
}

/** Normalise anything thrown by persistence into a `RoomError`. */
export function normaliseRoomError(e: unknown): RoomError {
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; message?: unknown }
    if (typeof o.code === 'string' && CODES.includes(o.code as RoomErrorCode)) {
      return {
        code: o.code as RoomErrorCode,
        message: typeof o.message === 'string' ? o.message : String(o.code),
      }
    }
    if (e instanceof Error) return { code: 'unknown', message: e.message }
  }
  return { code: 'unknown', message: typeof e === 'string' ? e : 'Unknown room error' }
}
