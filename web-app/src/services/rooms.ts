/**
 * Typed wrappers over the discussion-room Tauri commands
 * (`src-tauri/src/core/rooms`, docs/DISCUSSION_ROOMS.md "Persistence").
 *
 * Every wrapper rejects with a `RoomError` (`{ code, message }`), whatever
 * shape the underlying invoke rejection had.
 */
import { invoke } from '@tauri-apps/api/core'
import { trackArchiveWork } from '@/lib/archive'
import type { ApplyPreview } from '@/lib/rooms/applyReview'
import type {
  Room,
  RoomChangedFile,
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

/**
 * With the archive on this moves the room into the archive, so it is tracked:
 * the Archive page waits for it rather than listing a half-moved room.
 */
export async function deleteRoom(roomId: string): Promise<void> {
  await trackArchiveWork(call<null>('room_delete', { roomId }))
}

/** A compare participant's isolated workspace (see `lib/rooms/isolation.ts`). */
export function ensureRoomWorkspace(
  roomId: string,
  participantId: string,
  folder: string
): Promise<{ path: string; kind: 'worktree' | 'copy' }> {
  return call('room_workspace_ensure', { roomId, participantId, folder })
}

export function roomWorkspaceChanges(
  roomId: string,
  participantId: string,
  scope: 'turn' | 'all' = 'all'
): Promise<{ files: RoomChangedFile[] }> {
  return call('room_workspace_changes', { roomId, participantId, scope })
}

/** Mark the start of a participant turn in its workspace (see `scope: 'turn'`). */
export async function markRoomWorkspaceTurn(roomId: string, participantId: string): Promise<void> {
  await call<null>('room_workspace_mark_turn', { roomId, participantId })
}

/** The participant's whole change as one patch, previewed before applying. */
export function roomWorkspacePatch(roomId: string, participantId: string): Promise<string> {
  return call('room_workspace_patch', { roomId, participantId })
}

/** Throw away what the participant changed in its workspace. */
export async function resetRoomWorkspace(roomId: string, participantId: string): Promise<void> {
  await call<null>('room_workspace_reset', { roomId, participantId })
}

/**
 * Apply the participant's change to the user's folder -- all of it, or only
 * `paths` (paths after the change); resolves with the file count.
 */
export function applyRoomWorkspace(roomId: string, participantId: string, paths?: string[]): Promise<number> {
  return call('room_workspace_apply', { roomId, participantId, paths: paths ?? null })
}

/** The review before applying: patch, target, dry-run per file, uncommitted overlaps. */
export function roomWorkspaceApplyPreview(roomId: string, participantId: string): Promise<ApplyPreview> {
  return call('room_workspace_apply_preview', { roomId, participantId })
}

/** Reverse the last apply in the user's folder. */
export async function undoRoomWorkspaceApply(roomId: string, participantId: string): Promise<void> {
  await call<null>('room_workspace_undo_apply', { roomId, participantId })
}

export async function removeRoomWorkspaces(roomId: string): Promise<void> {
  await call<null>('room_workspace_remove', { roomId })
}
