/**
 * Participant availability preflight and suspension
 * (docs/DISCUSSION_ROOMS.md, "Participants and availability").
 */
import { useModelProvider } from '@/hooks/useModelProvider'
import { isProviderUsable } from '@/lib/providerReadiness'
import { knownContextWindow } from '@/lib/knownContextWindow'
import { FALLBACK_CONTEXT_WINDOW } from './context'
import type {
  Participant,
  ParticipantAvailability,
  ParticipantUnavailableReason,
  Room,
  RoomModelRef,
} from './types'

export type ProviderLookup = (providerName: string) => ModelProvider | undefined

export const defaultProviderLookup: ProviderLookup = (name) =>
  useModelProvider.getState().getProviderByName(name)

/** Provider errors on this many consecutive turns suspend a participant. */
export const CONSECUTIVE_ERRORS_TO_SUSPEND = 2

/**
 * Reasons that persist until the user resumes/starts the room or edits the
 * participant (a failed local load is not retried every round).
 */
const STICKY_REASONS: ParticipantUnavailableReason[] = ['repeated-errors', 'load-failed']

export function resolveModel(
  ref: RoomModelRef | null | undefined,
  lookup: ProviderLookup
): { provider?: ModelProvider; model?: Model } {
  if (!ref) return {}
  const provider = lookup(ref.provider)
  const model = provider?.models?.find((m) => m.id === ref.id)
  return { provider, model }
}

export function contextWindowFor(ref: RoomModelRef, lookup: ProviderLookup): number {
  const { provider, model } = resolveModel(ref, lookup)
  if (!model) return FALLBACK_CONTEXT_WINDOW
  try {
    return (
      knownContextWindow(
        model as unknown as Parameters<typeof knownContextWindow>[0],
        provider as unknown as Parameters<typeof knownContextWindow>[1]
      ) ?? FALLBACK_CONTEXT_WINDOW
    )
  } catch {
    return FALLBACK_CONTEXT_WINDOW
  }
}

export function modelSupportsTools(ref: RoomModelRef, lookup: ProviderLookup): boolean {
  return resolveModel(ref, lookup).model?.capabilities?.includes('tools') ?? false
}

export type ModelProblem = { reason: ParticipantUnavailableReason; message: string }

/** Why a model cannot be used right now, or null. */
export function checkModel(
  ref: RoomModelRef | null | undefined,
  lookup: ProviderLookup,
  opts: { minimumTokens?: number; contextWindow?: number } = {}
): ModelProblem | null {
  if (!ref) return { reason: 'model-missing', message: 'No model is selected.' }
  const provider = lookup(ref.provider)
  if (!provider) {
    return {
      reason: 'provider-missing',
      message: `The provider "${ref.provider}" is not configured in Jan.`,
    }
  }
  if (!isProviderUsable(provider)) {
    return {
      reason: 'provider-not-configured',
      message: `The provider "${ref.provider}" is not ready (for example, it has no API key).`,
    }
  }
  if (!provider.models?.some((m) => m.id === ref.id)) {
    return {
      reason: 'model-missing',
      message: `The model "${ref.id}" is not available from "${ref.provider}".`,
    }
  }
  if (opts.minimumTokens != null) {
    const window = opts.contextWindow ?? contextWindowFor(ref, lookup)
    if (window < opts.minimumTokens) {
      return {
        reason: 'context-too-small',
        message: `The model's context window (${window} tokens) is too small for the room prompt and reply (${opts.minimumTokens} tokens).`,
      }
    }
  }
  return null
}

export type AvailabilityChange = {
  participant: Participant
  from: ParticipantAvailability
  to: ParticipantAvailability
}

/** Re-evaluate every non-removed participant; sticky suspensions are kept. */
export function preflightParticipants(
  room: Room,
  opts: {
    lookup: ProviderLookup
    now: number
    minimumTokens: (p: Participant) => number
    contextWindow?: (ref: RoomModelRef) => number
  }
): { room: Room; changes: AvailabilityChange[] } {
  const changes: AvailabilityChange[] = []
  const participants = room.participants.map((p) => {
    if (p.removed) return p
    const current = p.availability
    if (current.state === 'unavailable' && STICKY_REASONS.includes(current.reason)) return p
    const problem = checkModel(p.model, opts.lookup, {
      minimumTokens: opts.minimumTokens(p),
      contextWindow: opts.contextWindow?.(p.model),
    })
    const next: ParticipantAvailability = problem
      ? { state: 'unavailable', reason: problem.reason, message: problem.message, at: opts.now }
      : { state: 'available' }
    const changed =
      current.state !== next.state ||
      (current.state === 'unavailable' &&
        next.state === 'unavailable' &&
        current.reason !== next.reason)
    if (!changed) return p
    const updated = { ...p, availability: next }
    changes.push({ participant: updated, from: current, to: next })
    return updated
  })
  return { room: { ...room, participants }, changes }
}

/** Clear suspensions on resume/start and on edit. */
export function clearSuspensions(room: Room): Room {
  return {
    ...room,
    participants: room.participants.map((p) =>
      p.availability.state === 'unavailable' &&
      (p.availability.reason === 'repeated-errors' || p.availability.reason === 'load-failed')
        ? { ...p, availability: { state: 'unknown' } }
        : p
    ),
  }
}

export function markUnavailable(
  room: Room,
  participantId: string,
  reason: ParticipantUnavailableReason,
  message: string,
  now: number
): Room {
  return {
    ...room,
    participants: room.participants.map((p) =>
      p.id === participantId
        ? { ...p, availability: { state: 'unavailable', reason, message, at: now } }
        : p
    ),
  }
}

/**
 * The tool access a participant actually runs with. Rooms advertise no tools
 * in this version: `read` is not yet available, so it runs as `none` and the
 * returned note says why. Global tool approvals are never consulted.
 */
export function effectiveToolAccess(
  p: Participant,
  lookup: ProviderLookup
): { access: 'none'; note: string | null } {
  if (p.toolAccess !== 'read') return { access: 'none', note: null }
  if (!modelSupportsTools(p.model, lookup)) {
    return {
      access: 'none',
      note: `${p.name}'s model does not support tools, so ${p.name} runs without tools.`,
    }
  }
  return {
    access: 'none',
    note: `Read-only tools are not yet available in rooms, so ${p.name} runs without tools.`,
  }
}
