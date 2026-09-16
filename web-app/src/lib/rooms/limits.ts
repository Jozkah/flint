/**
 * Room limits: clamping, breach checks, the hard per-run call ceiling and
 * usage/cost accounting (docs/DISCUSSION_ROOMS.md, "Limits and guaranteed
 * termination").
 *
 * Everything here is pure. The engine owns the clock and passes `now` in.
 */
import { estimateTokens } from '@/lib/context-manager'
import {
  DEFAULT_ROOM_LIMITS,
  ROOM_LIMIT_CEILINGS,
  type Participant,
  type Room,
  type RoomLimits,
  type RoomModelRef,
  type RoomUsage,
} from './types'

/**
 * Model calls allowed per `start`/`resume`, independent of any setting:
 * moderator turns, votes, final positions, summaries and retries included.
 */
export const HARD_CALL_CEILING =
  ROOM_LIMIT_CEILINGS.maxTurns + Math.floor(ROOM_LIMIT_CEILINGS.maxTurns / 2)

function clampInt(value: unknown, fallback: number, ceiling: number): number {
  // null/undefined (JSON turns Infinity into null) fall back to the default.
  if (value == null || value === '') return Math.min(fallback, ceiling)
  const n = typeof value === 'number' ? value : Number(value)
  if (n === Number.POSITIVE_INFINITY) return ceiling
  if (!Number.isFinite(n)) return Math.min(fallback, ceiling)
  return Math.max(1, Math.min(ceiling, Math.floor(n)))
}

/** Clamp any input (including absurd or malformed values) to the ceilings. */
export function clampLimits(input: Partial<RoomLimits> | null | undefined): RoomLimits {
  const l = input ?? {}
  const d = DEFAULT_ROOM_LIMITS
  const c = ROOM_LIMIT_CEILINGS
  let cost: number | null = null
  if (l.maxCostUsd != null) {
    const n = Number(l.maxCostUsd)
    cost = Number.isFinite(n) && n >= 0 ? n : null
  }
  let similarity = Number(l.repetitionSimilarity)
  if (!Number.isFinite(similarity)) similarity = d.repetitionSimilarity
  similarity = Math.max(0, Math.min(1, similarity))
  return {
    maxRounds: clampInt(l.maxRounds, d.maxRounds, c.maxRounds),
    maxTurns: clampInt(l.maxTurns, d.maxTurns, c.maxTurns),
    maxConsecutivePerParticipant: clampInt(
      l.maxConsecutivePerParticipant,
      d.maxConsecutivePerParticipant,
      c.maxConsecutivePerParticipant
    ),
    maxTotalTokens: clampInt(l.maxTotalTokens, d.maxTotalTokens, c.maxTotalTokens),
    maxOutputTokensPerTurn: clampInt(
      l.maxOutputTokensPerTurn,
      d.maxOutputTokensPerTurn,
      c.maxOutputTokensPerTurn
    ),
    maxCostUsd: cost,
    maxDurationMs: clampInt(l.maxDurationMs, d.maxDurationMs, c.maxDurationMs),
    maxRepetitiveTurns: clampInt(
      l.maxRepetitiveTurns,
      d.maxRepetitiveTurns,
      c.maxRepetitiveTurns
    ),
    repetitionSimilarity: similarity,
  }
}

export function emptyUsage(): RoomUsage {
  return {
    turns: 0,
    rounds: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimated: false,
    costUsd: 0,
    activeMs: 0,
    consecutiveRepetitive: 0,
  }
}

export type LimitBreach = keyof RoomLimits | 'ceiling'

export type CheckLimitsOptions = {
  /** When the current running stretch began; its elapsed time counts too. */
  activeSince?: number | null
  /** Model calls already made in this run. */
  callsMade?: number
  /**
   * Speaking limits (turns, rounds) apply to discussion turns. Closing work
   * (votes, final positions, synthesis) is still bound by tokens, time, cost
   * and the ceiling, but not by turns or rounds.
   */
  speaking?: boolean
}

/** The first breached limit, or null. Checked before every model call. */
export function checkLimits(
  room: Room,
  now: number,
  opts: CheckLimitsOptions = {}
): LimitBreach | null {
  const limits = clampLimits(room.limits)
  const u = room.usage
  if ((opts.callsMade ?? 0) >= HARD_CALL_CEILING) return 'ceiling'
  if (opts.speaking !== false) {
    if (u.turns >= limits.maxTurns) return 'maxTurns'
    if (u.rounds >= limits.maxRounds) return 'maxRounds'
  }
  if (u.inputTokens + u.outputTokens >= limits.maxTotalTokens) return 'maxTotalTokens'
  const elapsed =
    u.activeMs + (opts.activeSince != null ? Math.max(0, now - opts.activeSince) : 0)
  if (elapsed >= limits.maxDurationMs) return 'maxDurationMs'
  if (
    limits.maxCostUsd != null &&
    u.costUsd != null &&
    costIsEnforceable(room) &&
    u.costUsd >= limits.maxCostUsd
  ) {
    return 'maxCostUsd'
  }
  return null
}

/**
 * Limits raised to let a stopped room run `addRounds` more rounds.
 *
 * "Continue" must actually continue: raising only the one limit that stopped
 * the room (by a small count) fails for the token, time and cost limits, where
 * a "+3" means +3 tokens / +3 ms and re-trips instantly -- and even a good
 * round bump still dies on whichever *other* limit is next. So every limit is
 * lifted together, to the room's own per-round consumption times the number of
 * rounds asked for (with headroom), never below its current value, and always
 * clamped to the fixed ceilings. A room that hits a ceiling truly cannot go
 * further; everything short of that continues.
 */
export function extendedLimits(room: Room, addRounds: number): RoomLimits {
  const n = Math.max(1, Math.floor(addRounds))
  const u = room.usage
  const cur = clampLimits(room.limits)
  const rounds = Math.max(1, u.rounds)
  const tokens = u.inputTokens + u.outputTokens
  // Per-round consumption so far, with a 1.5x safety margin for the estimate.
  const perRoundTurns = Math.max(1, Math.ceil((u.turns / rounds) * 1.5))
  const perRoundTokens = Math.ceil((tokens / rounds) * 1.5)
  const perRoundMs = Math.ceil((u.activeMs / rounds) * 1.5)
  const raise = (currentLimit: number, floor: number) => Math.max(currentLimit, floor)
  const next: Partial<RoomLimits> = {
    ...cur,
    maxRounds: raise(cur.maxRounds, u.rounds + n),
    maxTurns: raise(cur.maxTurns, u.turns + n * perRoundTurns + 1),
    maxTotalTokens: raise(cur.maxTotalTokens, tokens + n * perRoundTokens + 1),
    // A full extra minute on top, so a slow first turn after resume has room.
    maxDurationMs: raise(cur.maxDurationMs, u.activeMs + n * perRoundMs + 60_000),
  }
  if (cur.maxCostUsd != null) {
    const perRoundCost = ((u.costUsd ?? 0) / rounds) * 1.5
    next.maxCostUsd = Math.max(cur.maxCostUsd, (u.costUsd ?? 0) + n * perRoundCost + 0.01)
  }
  return clampLimits(next)
}

/**
 * The cost limit applies only when every model that can speak (active
 * participants, and the moderator when enabled) has user-entered pricing.
 */
export function costIsEnforceable(room: Room): boolean {
  const speakers = room.participants.filter((p) => !p.removed)
  if (speakers.length === 0 || speakers.some((p) => !p.pricing)) return false
  if (room.moderator.enabled && room.moderator.model) {
    return !!pricingForModel(room.participants, room.moderator.model)
  }
  return true
}

export type CallUsage = { inputTokens: number; outputTokens: number; estimated: boolean }

/** Provider-reported usage when present, else an estimate of prompt + reply. */
export function measureCall(input: {
  providerUsage?: { inputTokens?: number | null; outputTokens?: number | null } | null
  promptText: string
  replyText: string
}): CallUsage {
  const pu = input.providerUsage
  const inOk = pu != null && typeof pu.inputTokens === 'number' && Number.isFinite(pu.inputTokens)
  const outOk =
    pu != null && typeof pu.outputTokens === 'number' && Number.isFinite(pu.outputTokens)
  return {
    inputTokens: inOk ? (pu!.inputTokens as number) : estimateTokens(input.promptText),
    outputTokens: outOk ? (pu!.outputTokens as number) : estimateTokens(input.replyText),
    estimated: !(inOk && outOk),
  }
}

/**
 * User-entered pricing for a model: the first participant using that exact
 * model with prices. The moderator has no pricing field of its own, so it is
 * priced only when a participant shares its model.
 */
export function pricingForModel(
  participants: Participant[],
  model: RoomModelRef
): Participant['pricing'] | undefined {
  return participants.find(
    (p) => p.model.provider === model.provider && p.model.id === model.id && p.pricing
  )?.pricing
}

/**
 * Add one call to the room usage. Cost stays computable only while every call
 * came from a priced model; once an unpriced model speaks it becomes null and
 * no cost is invented.
 */
export function addCallUsage(
  usage: RoomUsage,
  call: CallUsage,
  pricing: Participant['pricing'] | undefined
): RoomUsage {
  let costUsd: number | null = usage.costUsd
  if (costUsd != null) {
    costUsd = pricing
      ? costUsd +
        (call.inputTokens * pricing.inputPerMTokUsd +
          call.outputTokens * pricing.outputPerMTokUsd) /
          1_000_000
      : null
  }
  return {
    ...usage,
    inputTokens: usage.inputTokens + call.inputTokens,
    outputTokens: usage.outputTokens + call.outputTokens,
    estimated: usage.estimated || call.estimated,
    costUsd,
  }
}

/** Human text for a breach, used in the `system` message. */
export function describeBreach(limit: LimitBreach): string {
  switch (limit) {
    case 'ceiling':
      return 'The room reached the hard ceiling on model calls for one run.'
    case 'maxTurns':
      return 'The room reached its turn limit.'
    case 'maxRounds':
      return 'The room reached its round limit.'
    case 'maxTotalTokens':
      return 'The room reached its token limit.'
    case 'maxDurationMs':
      return 'The room reached its time limit.'
    case 'maxCostUsd':
      return 'The room reached its cost limit.'
    default:
      return `The room reached its limit (${limit}).`
  }
}
