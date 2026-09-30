import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { getRoomPersistence } from '@/lib/rooms/persistence'
import { messagesFromJournal } from '@/lib/rooms/recovery'
import { updateRoomSettings } from '@/lib/rooms/controller'
import { useRoomsStore } from '@/lib/rooms/store'
import type { RoomMessage } from '@/lib/rooms/types'
import { regenerateThreadTitle } from '@/lib/thread-title-summarizer'
import { transcriptOf, type RegenerateResult } from '@/lib/regenerateTitle'

/** A new title for a Cowork session, from what it has been asked and answered. */
export async function regenerateCoworkTitle(
  sessionId: string
): Promise<RegenerateResult> {
  const session = useCoworkSessions
    .getState()
    .sessions.find((s) => s.id === sessionId)
  if (!session) return 'failed'
  const transcript = transcriptOf(
    session.turns
      .filter((t) => t.role === 'user' || t.role === 'assistant')
      .map((t) => ({
        speaker: t.role === 'assistant' ? 'Assistant' : 'User',
        text: t.content,
      }))
  )
  if (!transcript) return 'empty'
  const title = await regenerateThreadTitle(
    transcript,
    new AbortController().signal,
    sessionId
  )
  if (!title) return 'failed'
  useCoworkSessions.getState().setTitle(sessionId, title)
  return 'done'
}

const SPOKEN: ReadonlySet<RoomMessage['kind']> = new Set([
  'speech',
  'user',
  'synthesis',
  'final-position',
])

/**
 * A new title for a discussion room, from its objective and what was said.
 * A running room is refused, as every other edit to it is.
 */
export async function regenerateRoomTitle(
  roomId: string
): Promise<RegenerateResult | 'busy'> {
  const { room, journal } = await getRoomPersistence().getRoom(roomId)
  if (room.status === 'running') return 'busy'
  const spoken = messagesFromJournal(roomId, journal)
    .filter((m) => SPOKEN.has(m.kind))
    .map((m) => ({
      speaker: m.author.kind === 'user' ? 'User' : 'name' in m.author ? m.author.name : 'Moderator',
      text: m.text,
    }))
  const transcript = transcriptOf([
    ...(room.objective.trim()
      ? [{ speaker: 'Objective', text: room.objective }]
      : []),
    ...spoken,
  ])
  if (!transcript) return 'empty'
  const title = await regenerateThreadTitle(
    transcript,
    new AbortController().signal,
    roomId
  )
  if (!title) return 'failed'
  await updateRoomSettings(room, { title })
  void useRoomsStore.getState().loadRooms()
  return 'done'
}
