/**
 * Speaking policy: who speaks next, consecutive-speaker enforcement and round
 * bookkeeping (docs/DISCUSSION_ROOMS.md, "Speaking modes").
 */
import { clampLimits } from './limits'
import type { ModeratorDirective, Participant, Room, RoomMessage } from './types'

/** Non-removed, not-unavailable participants in round-robin order. */
export function activeParticipants(room: Room): Participant[] {
  return room.participants
    .filter((p) => !p.removed && p.availability.state !== 'unavailable')
    .sort((a, b) => a.order - b.order)
}

/** The participant who spoke last and how many speech turns in a row. */
export function consecutiveRun(messages: RoomMessage[]): {
  participantId: string | null
  count: number
} {
  let id: string | null = null
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    // Failed turns count: the speaker had the floor even if the call failed.
    if (m.kind !== 'speech') continue
    if (m.author.kind !== 'participant') break
    if (id === null) id = m.author.participantId
    if (m.author.participantId !== id) break
    count++
  }
  return { participantId: id, count }
}

export function resolveParticipant(
  ref: string | null | undefined,
  participants: Participant[]
): Participant | null {
  if (!ref) return null
  const key = ref.trim().replace(/^@/, '')
  if (!key) return null
  const byId = participants.find((p) => p.id === key)
  if (byId) return byId
  const lower = key.toLowerCase()
  return participants.find((p) => p.name.trim().toLowerCase() === lower) ?? null
}

function roundComplete(room: Room, active: Participant[]): boolean {
  return active.length > 0 && active.every((p) => room.spokenThisRound.includes(p.id))
}

function blockedByConsecutive(
  room: Room,
  messages: RoomMessage[],
  candidate: Participant
): boolean {
  const max = clampLimits(room.limits).maxConsecutivePerParticipant
  const run = consecutiveRun(messages)
  return run.participantId === candidate.id && run.count >= max
}

/** Next in round-robin order, honouring the consecutive limit when possible. */
export function roundRobinNext(
  room: Room,
  messages: RoomMessage[],
  exclude: string[] = []
): Participant | null {
  const active = activeParticipants(room).filter((p) => !exclude.includes(p.id))
  if (active.length === 0) return null
  const fresh = roundComplete(room, activeParticipants(room))
  let ordered: Participant[]
  if (fresh || room.round === 0) {
    // New round: start after the last speaker so nobody opens twice in a row.
    const last = consecutiveRun(messages).participantId
    const idx = active.findIndex((p) => p.id === last)
    ordered = idx < 0 ? active : [...active.slice(idx + 1), ...active.slice(0, idx + 1)]
  } else {
    const pending = active.filter((p) => !room.spokenThisRound.includes(p.id))
    const spoken = active.filter((p) => room.spokenThisRound.includes(p.id))
    ordered = [...pending, ...spoken]
  }
  return ordered.find((p) => !blockedByConsecutive(room, messages, p)) ?? null
}

export type SpeakerChoice =
  | {
      kind: 'speaker'
      participant: Participant
      via: 'round-robin' | 'user-selected' | 'moderator' | 'fallback'
      /** Set when a fallback happened; recorded as a `system` note. */
      note?: string
    }
  | { kind: 'awaiting-user' }
  | { kind: 'none'; note: string }

export function nextSpeaker(input: {
  room: Room
  messages: RoomMessage[]
  /** A user's explicit choice (selectNext), honoured in every mode. */
  override?: string | null
  /** Moderator directive for this turn, moderator-selected mode only. */
  directive?: ModeratorDirective | null
  /** Why the directive is missing, when it is. */
  directiveProblem?: string | null
}): SpeakerChoice {
  const { room, messages } = input
  const active = activeParticipants(room)
  if (active.length === 0) return { kind: 'none', note: 'No participant is available.' }

  const fallback = (why: string): SpeakerChoice => {
    const p = roundRobinNext(room, messages)
    if (!p) return { kind: 'none', note: `${why} No participant may speak next.` }
    return { kind: 'speaker', participant: p, via: 'fallback', note: why }
  }

  const overrideRef = input.override ?? room.nextSpeakerId
  if (overrideRef) {
    const chosen = resolveParticipant(overrideRef, active)
    if (chosen && !blockedByConsecutive(room, messages, chosen)) {
      return { kind: 'speaker', participant: chosen, via: 'user-selected' }
    }
    // A blocked explicit choice is explained in every mode, not dropped in
    // silence outside user-selected (#180).
    if (chosen) {
      return fallback(
        `${chosen.name} would exceed the consecutive-turn limit; the next speaker was chosen in order.`
      )
    }
    if (room.mode === 'user-selected') return { kind: 'awaiting-user' }
  }

  switch (room.mode) {
    case 'round-robin': {
      const p = roundRobinNext(room, messages)
      return p
        ? { kind: 'speaker', participant: p, via: 'round-robin' }
        : { kind: 'none', note: 'No participant may speak next.' }
    }
    case 'user-selected':
      return { kind: 'awaiting-user' }
    case 'moderator-selected': {
      const d = input.directive
      if (!d) {
        return fallback(
          `${input.directiveProblem ?? 'The moderator gave no usable directive.'} The next speaker was chosen in order.`
        )
      }
      if (!d.next) {
        return fallback('The moderator did not name a next speaker; the next speaker was chosen in order.')
      }
      const chosen = resolveParticipant(d.next, active)
      if (!chosen) {
        return fallback(
          `The moderator named "${d.next.slice(0, 80)}", who is not an available participant; the next speaker was chosen in order.`
        )
      }
      if (blockedByConsecutive(room, messages, chosen)) {
        return fallback(
          `${chosen.name} would exceed the consecutive-turn limit; the next speaker was chosen in order.`
        )
      }
      return { kind: 'speaker', participant: chosen, via: 'moderator' }
    }
  }
}

/**
 * Round bookkeeping before a speaking turn: the first turn opens round 1, and
 * a turn after every active participant has spoken opens the next round.
 */
export function beginSpeakingTurn(room: Room): Room {
  const active = activeParticipants(room)
  if (room.round === 0) return { ...room, round: 1, spokenThisRound: [] }
  if (roundComplete(room, active)) {
    return {
      ...room,
      round: room.round + 1,
      spokenThisRound: [],
      usage: { ...room.usage, rounds: Math.max(room.usage.rounds, room.round) },
    }
  }
  return room
}

/** Whether the next speaking turn would open a new round. */
export function atRoundBoundary(room: Room): boolean {
  return room.round === 0 || roundComplete(room, activeParticipants(room))
}

/** Record that a participant spoke; closes the round when everyone has. */
export function markSpoken(room: Room, participantId: string): Room {
  const spoken = room.spokenThisRound.includes(participantId)
    ? room.spokenThisRound
    : [...room.spokenThisRound, participantId]
  const next = { ...room, spokenThisRound: spoken }
  if (roundComplete(next, activeParticipants(next))) {
    next.usage = { ...next.usage, rounds: Math.max(next.usage.rounds, next.round) }
  }
  return next
}
