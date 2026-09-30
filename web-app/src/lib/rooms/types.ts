/**
 * Shared types for multi-model discussion rooms (docs/DISCUSSION_ROOMS.md).
 *
 * This file is the contract between the persistence layer (Rust `core::rooms`
 * via `services/rooms`), the orchestration engine (`lib/rooms/engine.ts`) and
 * the UI (`routes/rooms*`, `containers/rooms/*`). Every field that crosses the
 * Tauri boundary is camelCase JSON.
 *
 * Nothing in a room can grant, approve or widen a permission. Participant tool
 * access is set only by the user through the room editor; transcript content
 * (from models, the moderator or other participants) is data, never authority.
 */

import type { WorkProfileId } from '@/lib/workProfiles'

import type { ClearScope } from './clearRoom'

export const ROOM_SCHEMA_VERSION = 1 as const

/** A model reference resolved through Flint's provider store and ModelFactory. */
export type RoomModelRef = {
  /** `ProviderObject.provider` */
  provider: string
  /** `Model.id` within that provider */
  id: string
}

export type RoomStatus =
  | 'draft' // editable, never started
  | 'running' // the engine loop is active
  | 'awaiting-user' // waiting for the user to choose the next speaker or reply
  | 'paused' // stopped by the user or by a restart; resumable
  | 'stopped' // stopped by the user; not resumable without a new start
  | 'completed' // reached synthesis or a clean end
  | 'failed' // could not continue (e.g. fewer than two usable participants)

export type SpeakingMode = 'round-robin' | 'user-selected' | 'moderator-selected'

/**
 * Tool access per participant. Only the user sets it. `read` runs Flint's Cowork
 * tools in Plan mode (mutations refused by the existing gate) with no approval
 * callback, so nothing that needs approval can ever execute inside a room.
 * Models without the `tools` capability are forced to `none`.
 */
export type ToolAccess = 'none' | 'read' | 'edit' | 'full'

export type ParticipantAvailability =
  | { state: 'unknown' }
  | { state: 'available' }
  | {
      state: 'unavailable'
      reason: ParticipantUnavailableReason
      message: string
      at: number
    }

export type ParticipantUnavailableReason =
  | 'provider-missing'
  | 'provider-not-configured' // e.g. no API key
  | 'model-missing'
  | 'load-failed' // local model could not start
  | 'repeated-errors' // suspended after consecutive provider errors
  | 'context-too-small' // cannot fit the minimum room context

export type Participant = {
  id: string
  /** Display name, unique within the room (case-insensitive). */
  name: string
  /** Free-text role, e.g. "skeptic", "domain expert". May be empty. */
  role: string
  model: RoomModelRef
  toolAccess: ToolAccess
  /** Removed participants stay in the list so transcript attribution resolves. */
  removed: boolean
  /** Position in round-robin order among non-removed participants. */
  order: number
  availability: ParticipantAvailability
  /** Optional user-entered prices, used only for the optional cost limit. */
  pricing?: { inputPerMTokUsd: number; outputPerMTokUsd: number }
  /**
   * How this participant's model reasons on its turns. Absent means the
   * model's own default: nothing reasoning-related is sent.
   */
  reasoning?: ParticipantReasoning
  /** The assistant whose personality this participant speaks with. */
  assistantId?: string
  /** The work profile this participant works in (review, plan, debug...). */
  workProfile?: WorkProfileId
}

/**
 * A participant's reasoning setting, in the same terms as chat's Reasoning
 * control: `mode` is Auto / On / Off, and `level` is the one value chat
 * stores under `thinking_budget_tokens` -- the Reasoning effort for a
 * provider that takes one, the Thinking Budget for llama.cpp.
 */
export type ParticipantReasoning = {
  mode?: 'auto' | 'on' | 'off'
  level?: 'low' | 'medium' | 'high' | 'xhigh' | 'unlimited'
}

export type ModeratorConfig = {
  enabled: boolean
  /** The moderator is its own identity, never one of the participants. */
  name: string
  model: RoomModelRef | null
}

export type RoomLimits = {
  /** A round ends when every active participant has spoken once (or the moderator closes it). */
  maxRounds: number
  /** Total speaking turns (participant messages) across the room. */
  maxTurns: number
  /** Same participant speaking back-to-back. */
  maxConsecutivePerParticipant: number
  /** Sum of input + output tokens reported or estimated for all model calls. */
  maxTotalTokens: number
  /** Cap on a single model reply. */
  maxOutputTokensPerTurn: number
  /** Optional; enforced only when every speaking model has pricing. */
  maxCostUsd: number | null
  /** Wall-clock running time, excluding paused/awaiting-user time. */
  maxDurationMs: number
  /** Stop when this many consecutive turns are near-duplicates of recent ones. */
  maxRepetitiveTurns: number
  /** Similarity in [0, 1] above which a turn counts as repetitive. */
  repetitionSimilarity: number
}

/** Code-enforced ceilings; settings are clamped to these regardless of input. */
export const ROOM_LIMIT_CEILINGS = {
  maxRounds: 50,
  maxTurns: 200,
  maxConsecutivePerParticipant: 5,
  maxTotalTokens: 2_000_000,
  maxOutputTokensPerTurn: 8_192,
  maxDurationMs: 4 * 60 * 60 * 1000,
  maxRepetitiveTurns: 10,
  maxParticipants: 8,
  maxTextLength: 20_000, // stored characters per message
} as const

export const DEFAULT_ROOM_LIMITS: RoomLimits = {
  maxRounds: 6,
  maxTurns: 40,
  maxConsecutivePerParticipant: 1,
  maxTotalTokens: 200_000,
  maxOutputTokensPerTurn: 1_024,
  maxCostUsd: null,
  maxDurationMs: 30 * 60 * 1000,
  maxRepetitiveTurns: 2,
  repetitionSimilarity: 0.9,
}

export type RoomUsage = {
  turns: number
  rounds: number
  inputTokens: number
  outputTokens: number
  /** True when any count came from an estimate rather than provider usage. */
  estimated: boolean
  /** null when cost is not computable (a speaking model has no pricing). */
  costUsd: number | null
  /** Running time accumulated while status was `running`. */
  activeMs: number
  consecutiveRepetitive: number
}

export type StopReason =
  | { kind: 'user' }
  | { kind: 'limit'; limit: keyof RoomLimits | 'ceiling' }
  | { kind: 'converged'; by: 'moderator' | 'repetition' | 'consensus' }
  | { kind: 'synthesized' }
  | { kind: 'no-participants'; message: string }
  | { kind: 'interrupted-by-restart' }
  | { kind: 'error'; code: string; message: string }

export type Room = {
  v: typeof ROOM_SCHEMA_VERSION
  id: string
  title: string
  objective: string
  status: RoomStatus
  mode: SpeakingMode
  moderator: ModeratorConfig
  participants: Participant[]
  /**
   * An optional working folder the room's tool-capable participants read from.
   * `null`/absent when no folder is attached. Persisted with the room.
   */
  folder?: string | null
  /** More folders beside `folder`, under the same access. */
  extraFolders?: string[]
  limits: RoomLimits
  usage: RoomUsage
  /** 1-based current round; 0 before the first turn. */
  round: number
  /** Participant ids that have spoken in the current round. */
  spokenThisRound: string[]
  /** Chosen next speaker for user-/moderator-selected modes, if any. */
  nextSpeakerId: string | null
  stopReason: StopReason | null
  /** Optimistic-concurrency revision; the backend refuses stale saves. */
  rev: number
  createdAt: number
  updatedAt: number
}

export type Address =
  | { kind: 'room' }
  | { kind: 'participant'; participantId: string }
  | { kind: 'moderator' }
  | { kind: 'user' }

export type RoomAuthor =
  | { kind: 'participant'; participantId: string; name: string }
  | { kind: 'moderator'; name: string }
  | { kind: 'user' }
  | { kind: 'system' }

export type RoomMessageKind =
  | 'speech'
  | 'moderator-note' // disagreement summary, targeted request, convergence note
  | 'user'
  | 'vote-call'
  | 'vote'
  | 'final-position'
  | 'synthesis'
  | 'system' // limits, availability changes, pauses
  | 'error'

export type VoteChoice = 'agree' | 'disagree' | 'abstain'

export type RoomMessage = {
  v: typeof ROOM_SCHEMA_VERSION
  id: string
  roomId: string
  /** Monotonic per room, assigned by the backend on append. */
  seq: number
  turnId: string | null
  author: RoomAuthor
  to: Address
  kind: RoomMessageKind
  text: string
  round: number
  createdAt: number
  status: 'complete' | 'interrupted' | 'failed'
  error?: { code: string; message: string }
  usage?: {
    inputTokens: number
    outputTokens: number
    estimated: boolean
    /** How fast the reply was written, when it could be measured. */
    tokensPerSecond?: number
  }
  vote?: { callId: string; choice: VoteChoice; proposal: string }
  /** For synthesis: dissent the engine appended deterministically. */
  dissent?: Array<{ participantId: string; name: string; position: string }>
  /** For moderator notes: the parsed directive, when one was produced. */
  directive?: ModeratorDirective
  /** The read-only tools a tool-capable participant used to produce this reply. */
  toolCalls?: RoomToolActivity[]
  /** For system notes: the history was compacted here (drawn as a divider). */
  compaction?: RoomCompaction
}

/** A compaction of the discussion, journaled so the divider survives reloads. */
export type RoomCompaction = {
  summarizedCount: number
  summary: string
}

/**
 * One tool a participant used in its turn, for the transcript. `name`/`ok` drive
 * the simple chip; `args`/`output` are captured for the expandable advanced view
 * (`output` is truncated to keep the transcript small).
 */
export type RoomToolActivity = {
  name: string
  ok: boolean
  args?: unknown
  output?: string
  /** The tool came from an MCP server (colours the chip like Cowork's). */
  mcp?: boolean
}

/** What the moderator model is asked to return (parsed leniently from JSON). */
export type ModeratorDirective = {
  next: string | null // participant name or id
  request: string | null // targeted request for the next speaker
  disagreements: string[]
  converged: boolean
  stop: boolean
  reason: string
}

/** Journal record for the append-only transcript file. */
export type RoomJournalRecord =
  | { type: 'turn-start'; turnId: string; speaker: RoomAuthor; round: number; at: number }
  | { type: 'message'; message: RoomMessage }

export type RoomSummary = Pick<
  Room,
  'id' | 'title' | 'objective' | 'status' | 'mode' | 'updatedAt' | 'createdAt'
> & { participantCount: number; turns: number }

export type RoomErrorCode =
  | 'not_found'
  | 'invalid_id'
  | 'invalid_room'
  | 'stale_revision'
  | 'too_large'
  | 'io'
  | 'unknown'

export type RoomError = { code: RoomErrorCode; message: string }

/** Actions the UI invokes. Implemented by `lib/rooms/controller.ts`. */
export interface RoomController {
  /** Forget what was said in the room (and, by scope, more). Refused while it runs. */
  clearRoom(roomId: string, scope: ClearScope): Promise<void>
  start(roomId: string): Promise<void>
  pause(roomId: string): Promise<void>
  resume(roomId: string): Promise<void>
  stop(roomId: string): Promise<void>
  /** user-selected mode, or an override in any mode while not mid-turn */
  selectNext(roomId: string, participantId: string): Promise<void>
  sendUserMessage(roomId: string, text: string, to: Address): Promise<void>
  /**
   * Raise the limit that stopped the room by `addUnits` and continue it,
   * optionally posting `text` (addressed by `to`) first. For a room stopped
   * because a limit was reached, since a plain message alone would only
   * re-trip the same limit.
   */
  extendLimit(roomId: string, addUnits: number, text?: string, to?: Address): Promise<void>
  callVote(roomId: string, proposal: string): Promise<void>
  requestFinalPositions(roomId: string): Promise<void>
  synthesize(roomId: string): Promise<void>
  /** Abort the in-flight turn only; the room pauses. */
  cancelTurn(roomId: string): Promise<void>
}

/** Live, non-persisted view of the turn being streamed. */
export type LiveTurn = {
  roomId: string
  turnId: string
  author: RoomAuthor
  text: string
  startedAt: number
  /** The turn is pausing to compact (summarise) earlier messages that no longer
   * fit the model's context window, before it speaks. */
  compacting?: boolean
}
