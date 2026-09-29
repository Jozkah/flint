import { useThreads } from '@/hooks/useThreads'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { roomController } from '@/lib/rooms/controller'
import { getRoomPersistence } from '@/lib/rooms/persistence'
import type { CreateRoomInput, RoomSettingsPatch } from '@/lib/rooms/controller'

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

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
    const input = rec(p.input) as CreateRoomInput & Record<string, unknown>
    const title = str(input.title)
    if (!title) throw new Error('Room title is required')
    const room = await roomController.createRoom({
      ...input,
      title,
      objective: str(input.objective),
    } as CreateRoomInput)
    return { ok: true, id: room.id }
  }

  if (op === 'room.update') {
    const id = str(p.id)
    if (!id) throw new Error('Room id is required')
    const { room } = await getRoomPersistence().getRoom(id)
    const patch = rec(p.patch) as RoomSettingsPatch
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
    useCoworkSessions.getState().deleteSession(id)
    return { ok: true }
  }

  return null
}
