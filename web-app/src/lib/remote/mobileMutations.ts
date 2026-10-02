import { useThreads } from '@/hooks/useThreads'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { roomController } from '@/lib/rooms/controller'
import { getRoomPersistence } from '@/lib/rooms/persistence'
import {
  archiveCoworkSession,
  deleteCoworkSession,
} from '@/lib/coworkSessionLifecycle'
import { composerFor } from './composer'
import { useAppState } from '@/hooks/useAppState'
import type {
  CreateRoomInput,
  ParticipantInput,
  ParticipantPatch,
  RoomSettingsPatch,
} from '@/lib/rooms/controller'

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

const pick = (src: Record<string, unknown>, keys: string[]) => {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (k in src && src[k] !== undefined) out[k] = src[k]
  return out
}

/**
 * A phone may only change a room's plain settings. Folder and per-participant
 * toolAccess widen what the room can touch on the desktop, so they are dropped
 * here and stay desktop-only (Cowork's `cowork.send` guards folders the same way).
 */
function safeRoomPatch(raw: Record<string, unknown>): RoomSettingsPatch {
  const patch = pick(raw, ['title', 'objective', 'mode', 'moderator', 'limits']) as RoomSettingsPatch
  if (Array.isArray(raw.participants)) {
    patch.participants = raw.participants.map(
      (x) => pick(rec(x), ['id', 'model', 'reasoning']) as ParticipantPatch
    )
  }
  return patch
}

/** Room creation from a phone: no folder, and every participant has no tools. */
function safeRoomInput(raw: Record<string, unknown>): CreateRoomInput {
  const input = pick(raw, ['title', 'objective', 'mode', 'moderator', 'limits']) as CreateRoomInput
  if (Array.isArray(raw.participants)) {
    input.participants = raw.participants.map((x) => ({
      ...pick(rec(x), ['name', 'role', 'model', 'reasoning']),
      toolAccess: 'none',
    })) as ParticipantInput[]
  }
  return input
}

/**
 * Phone mutations reuse the desktop's existing stores/controllers rather than
 * maintaining a second implementation. Room mutations are exposed as typed
 * room.create/update/delete RPCs; the small chat/Cowork menu mutations still
 * use the legacy settings.set mobile operation path. Permission-widening Cowork
 * actions are intentionally absent and continue to require desktop consent.
 */
export async function handleMobileMutation(
  raw: unknown
): Promise<Record<string, unknown> | null> {
  const p = rec(raw)
  const op = str(p.mobileOp)
  if (!op) return null

  if (op === 'room.create') {
    const input = rec(p.input)
    const title = str(input.title)
    if (!title) throw new Error('Room title is required')
    const room = await roomController.createRoom({
      ...safeRoomInput(input),
      title,
      objective: str(input.objective),
    })
    return { ok: true, id: room.id }
  }

  if (op === 'room.update') {
    const id = str(p.id)
    if (!id) throw new Error('Room id is required')
    const { room } = await getRoomPersistence().getRoom(id)
    const patch = safeRoomPatch(rec(p.patch))
    const next = await roomController.updateRoomSettings(room, patch)
    return { ok: true, id: next.id }
  }

  if (op === 'room.delete') {
    const id = str(p.id)
    if (!id) throw new Error('Room id is required')
    await roomController.deleteRoom(id)
    return { ok: true }
  }

  if (op === 'thread.rename') {
    const id = str(p.id)
    const title = str(p.title)
    if (!id || !title) throw new Error('Thread id and title are required')
    useThreads.getState().renameThread(id, title)
    return { ok: true }
  }

  if (op === 'thread.pin') {
    const id = str(p.id)
    if (!id) throw new Error('Thread id is required')
    useThreads.getState().toggleFavorite(id)
    return { ok: true }
  }

  if (op === 'thread.delete') {
    const id = str(p.id)
    if (!id) throw new Error('Thread id is required')
    // Stop an in-flight reply first so it doesn't stream into a deleted thread.
    if (useAppState.getState().busyThreads[id]) composerFor('chat', id)?.stop?.()
    useThreads.getState().deleteThread(id)
    return { ok: true }
  }

  if (op === 'cowork.fork') {
    const id = str(p.id)
    if (!id) throw new Error('Session id is required')
    const next = useCoworkSessions.getState().forkSession(id)
    if (!next) throw new Error('Session could not be forked')
    return { ok: true, id: next }
  }

  if (op === 'cowork.rename') {
    const id = str(p.id)
    const title = str(p.title)
    if (!id || !title) throw new Error('Session id and title are required')
    useCoworkSessions.getState().setTitle(id, title)
    return { ok: true }
  }

  if (op === 'cowork.delete') {
    const id = str(p.id)
    if (!id) throw new Error('Session id is required')
    // Archived like a delete on the desktop (the worktree is left alone), and
    // stops the session's run and drops everything held for it. With the
    // archive off, or if it cannot be written, this is the plain delete.
    const archived = await archiveCoworkSession(id, false).catch(() => false)
    if (!archived) deleteCoworkSession(id)
    return { ok: true }
  }

  return null
}
