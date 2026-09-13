/**
 * The persistence port used by the engine, store and controller.
 *
 * The default implementation lazily loads `@/services/rooms` (owned by the
 * persistence lane). `import.meta.glob` keeps this module compiling and
 * testable whether or not that file exists yet; tests inject their own
 * implementation with `setRoomPersistence`.
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

const SERVICE_PATH = '/src/services/rooms.ts'
const loaders = import.meta.glob(['/src/services/rooms.ts'])

async function loadService(): Promise<RoomsServiceModule> {
  const load = loaders[SERVICE_PATH]
  if (!load) {
    const err: RoomError = {
      code: 'unknown',
      message: 'Room persistence is not available in this build.',
    }
    throw err
  }
  return (await load()) as RoomsServiceModule
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
