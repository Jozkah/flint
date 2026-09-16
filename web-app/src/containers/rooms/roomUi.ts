/** Pure helpers shared by the rooms UI. No React, no engine. */
import type {
  Address,
  LiveTurn,
  Participant,
  Room,
  RoomJournalRecord,
  RoomLimits,
  RoomMessage,
  RoomStatus,
  StopReason,
  VoteChoice,
} from '@/lib/rooms/types'
import { ROOM_LIMIT_CEILINGS } from '@/lib/rooms/types'

type T = (key: string, options?: Record<string, unknown>) => string

const ACTIVE: RoomStatus[] = ['running', 'awaiting-user', 'paused']

export const isMidTurn = (room: Room, liveTurn: LiveTurn | null) =>
  room.status === 'running' && liveTurn?.roomId === room.id

/** Settings are editable unless the engine loop is (or may be) active. */
export const isEditable = (status: RoomStatus) =>
  status !== 'running' && status !== 'awaiting-user'

export const activeParticipants = (room: Room) =>
  room.participants.filter((p) => !p.removed).sort((a, b) => a.order - b.order)

export const availableParticipants = (room: Room) =>
  activeParticipants(room).filter((p) => p.availability.state !== 'unavailable')

export type ControlAvailability = {
  start: boolean
  pause: boolean
  resume: boolean
  stop: boolean
  cancelTurn: boolean
  selectNext: boolean
  callVote: boolean
  requestFinalPositions: boolean
  synthesize: boolean
}

export function controlAvailability(
  room: Room,
  liveTurn: LiveTurn | null
): ControlAvailability {
  const s = room.status
  const midTurn = isMidTurn(room, liveTurn)
  const betweenTurns = ACTIVE.includes(s) && !midTurn
  return {
    start:
      (s === 'draft' || s === 'stopped' || s === 'completed' || s === 'failed') &&
      activeParticipants(room).length >= 2,
    pause: s === 'running' || s === 'awaiting-user',
    resume: s === 'paused',
    stop: ACTIVE.includes(s),
    cancelTurn: midTurn,
    selectNext: betweenTurns && availableParticipants(room).length > 0,
    callVote: betweenTurns,
    requestFinalPositions: betweenTurns,
    synthesize: betweenTurns,
  }
}

/** Clamp a limit to [min, ceiling]. Returns the value and whether it was capped. */
export function clampLimit(
  key: keyof RoomLimits,
  value: number
): { value: number; capped: boolean } {
  if (!Number.isFinite(value)) return { value: LIMIT_MIN[key], capped: false }
  const max = limitCeiling(key)
  const min = LIMIT_MIN[key]
  if (max !== null && value > max) return { value: max, capped: true }
  if (value < min) return { value: min, capped: false }
  return { value, capped: false }
}

const LIMIT_MIN: Record<keyof RoomLimits, number> = {
  maxRounds: 1,
  maxTurns: 1,
  maxConsecutivePerParticipant: 1,
  maxTotalTokens: 1,
  maxOutputTokensPerTurn: 1,
  maxCostUsd: 0,
  maxDurationMs: 60_000,
  maxRepetitiveTurns: 1,
  repetitionSimilarity: 0,
}

export function limitCeiling(key: keyof RoomLimits): number | null {
  switch (key) {
    case 'maxCostUsd':
      return null
    case 'repetitionSimilarity':
      return 1
    default:
      return ROOM_LIMIT_CEILINGS[key]
  }
}

export const messagesOf = (journal: RoomJournalRecord[]): RoomMessage[] =>
  journal
    .flatMap((r) => (r.type === 'message' ? [r.message] : []))
    .sort((a, b) => a.seq - b.seq)

export type VoteTally = Record<VoteChoice, number>

export function voteTallies(messages: RoomMessage[]): Map<string, VoteTally> {
  const tallies = new Map<string, VoteTally>()
  for (const m of messages) {
    if (m.kind !== 'vote' || !m.vote) continue
    const t = tallies.get(m.vote.callId) ?? { agree: 0, disagree: 0, abstain: 0 }
    t[m.vote.choice] += 1
    tallies.set(m.vote.callId, t)
  }
  return tallies
}

export const findParticipant = (room: Room | null, id: string) =>
  room?.participants.find((p) => p.id === id)

export function participantAttribution(p: Participant | undefined, fallbackName: string) {
  if (!p) return fallbackName
  return [p.name, p.role.trim(), p.model.id].filter(Boolean).join(' · ')
}

/**
 * A palette of distinct colors for room participants, chosen to stay legible on
 * both the light and dark card backgrounds (mid-tone solids, not tints).
 */
const PARTICIPANT_COLORS = [
  '#e5484d', // red
  '#d6409f', // magenta
  '#8e4ec6', // violet
  '#3e63dd', // indigo
  '#0091ff', // blue
  '#12a594', // teal
  '#46a758', // green
  '#e5622d', // orange
] as const

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/**
 * A stable, distinct color for a participant, so their name in the transcript
 * header and every `@mention` of them read in one consistent color. Keyed by a
 * seed (the participant id) so a rename keeps the color.
 */
export function participantColor(seed: string): string {
  return PARTICIPANT_COLORS[hashString(seed) % PARTICIPANT_COLORS.length]
}

/**
 * Name -> color for every participant in the room, for coloring `@mentions` in
 * message bodies. Names are lower-cased so a mention matches regardless of case.
 */
export function participantColorsByName(room: Room | null): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of room?.participants ?? []) {
    const name = p.name.trim().toLowerCase()
    if (name) out.set(name, participantColor(p.id))
  }
  return out
}

export function addressLabel(to: Address, room: Room | null, t: T): string | null {
  switch (to.kind) {
    case 'room':
      return null
    case 'moderator':
      return t('rooms:transcript.toModerator')
    case 'user':
      return t('rooms:transcript.toUser')
    case 'participant':
      return t('rooms:transcript.toParticipant', {
        name: findParticipant(room, to.participantId)?.name ?? to.participantId,
      })
  }
}

export function stopReasonText(reason: StopReason, t: T): string {
  switch (reason.kind) {
    case 'user':
      return t('rooms:stopReason.user')
    case 'limit':
      return reason.limit === 'ceiling'
        ? t('rooms:stopReason.ceiling')
        : t('rooms:stopReason.limit', { limit: t(`rooms:limits.${reason.limit}`) })
    case 'converged':
      return reason.by === 'moderator'
        ? t('rooms:stopReason.converged-moderator')
        : t('rooms:stopReason.converged-repetition')
    case 'synthesized':
      return t('rooms:stopReason.synthesized')
    case 'no-participants':
      return t('rooms:stopReason.no-participants')
    case 'interrupted-by-restart':
      return t('rooms:stopReason.interrupted-by-restart')
    case 'error':
      return t('rooms:stopReason.error', { message: reason.message })
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export const formatNumber = (n: number) => n.toLocaleString('en-US')

export const formatUsd = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
