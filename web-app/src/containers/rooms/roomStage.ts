import type { LiveTurn, Participant, Room } from '@/lib/rooms/types'
import { activeParticipants, findParticipant } from './roomUi'

type T = (key: string, options?: Record<string, unknown>) => string

/** Statuses in which a room is under way (steering applies, the queue is live). */
export const ACTIVE_STATUSES = ['running', 'awaiting-user', 'paused']

export type Stage = {
  title: string
  hint: string
  speaker: Participant | undefined
  speakerName: string
}

/** Who is on stage right now, in words, for the top of the panel. */
export function stageFor(
  room: Room,
  live: LiveTurn | null,
  t: T,
  modelName: (p: Participant) => string,
  /** Turns in flight in this room (several at once in a compare room). */
  liveCount = live ? 1 : 0
): Stage {
  if (room.mode === 'compare' && live && liveCount > 1) {
    return {
      title: t('rooms:stage.comparing', { count: liveCount }),
      hint: t('rooms:stage.comparingHint'),
      speaker: undefined,
      speakerName: '',
    }
  }
  if (live && live.author.kind !== 'system') {
    const p =
      live.author.kind === 'participant'
        ? findParticipant(room, live.author.participantId)
        : undefined
    const name =
      live.author.kind === 'user'
        ? t('rooms:transcript.you')
        : live.author.name || p?.name || t('rooms:transcript.moderator')
    return {
      title: t(live.compacting ? 'rooms:stage.compacting' : 'rooms:stage.speaking', { name }),
      hint: p ? [p.role.trim(), modelName(p)].filter(Boolean).join(' · ') : '',
      speaker: p,
      speakerName: name,
    }
  }
  const count = activeParticipants(room).length
  const hint: Record<Room['status'], string> = {
    draft: t('rooms:stage.draftHint', { count, mode: t(`rooms:mode.${room.mode}`) }),
    running: t('rooms:stage.runningHint'),
    'awaiting-user': t(
      room.mode === 'compare' ? 'rooms:stage.compareAwaitingHint' : 'rooms:stage.awaitingHint'
    ),
    paused: t('rooms:stage.pausedHint'),
    stopped: t('rooms:stage.stoppedHint'),
    completed: t('rooms:stage.completedHint'),
    failed: t('rooms:stage.failedHint'),
  }
  return {
    title: t(
      room.mode === 'compare' && room.status === 'awaiting-user'
        ? 'rooms:stage.compareAwaiting'
        : `rooms:stage.${room.status}`
    ),
    hint: hint[room.status],
    speaker: undefined,
    speakerName: '',
  }
}

/**
 * The speaking order from here: the chosen next speaker first, then whoever
 * has not spoken this round, then the rest, and whoever is speaking right now
 * last, so "Up next" reads left to right.
 */
export function speakingQueue(room: Room, speakingId: string | null): Participant[] {
  const all = activeParticipants(room)
  if (!ACTIVE_STATUSES.includes(room.status)) return all
  const later = (p: Participant) =>
    p.id === speakingId ? 2 : room.spokenThisRound.includes(p.id) ? 1 : 0
  const next = all.filter((p) => p.id === room.nextSpeakerId && p.id !== speakingId)
  const rest = all.filter((p) => !next.includes(p))
  return [...next, ...rest.sort((a, b) => later(a) - later(b))]
}
