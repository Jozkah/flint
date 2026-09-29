import { useThreads } from '@/hooks/useThreads'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { roomController } from '@/lib/rooms/controller'
import { getRoomPersistence } from '@/lib/rooms/persistence'
import type { CreateRoomInput, RoomSettingsPatch } from '@/lib/rooms/controller'
import type { Navigate } from './appActions'

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * Extra mobile mutations that deliberately reuse the desktop stores/controllers.
 * These travel through `settings.set` so the wire protocol does not gain a
 * second mutation transport. Security-sensitive Cowork grants are intentionally
 * absent: they still require the desktop consent UI.
 */
export async function handleMobileMutation(
  navigate: Navigate,
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
    navigate({ to: '/rooms/$roomId', params: { roomId: room.id } })
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
    navigate({ to: '/cowork' })
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
