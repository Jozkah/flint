/**
 * Types, errors and tuning constants shared by the room engine's run classes
 * (`engine.ts`, `engineRunBase.ts`, `engineTurns.ts`).
 */
import { isMeaningfulSpeed } from '@/lib/tokenSpeed'
import type { ProviderLookup } from './availability'
import type { BuiltPrompt, SpeakerIdentity } from './context'
import type { LimitBreach } from './limits'
import type { StreamReply } from './callError'
import type { RoomPersistence } from './persistence'
import type { RoomWorkspaceDeps } from './isolation'
import type {
  Address,
  LiveTurn,
  Participant,
  Room,
  RoomAuthor,
  RoomJournalRecord,
  RoomMessage,
  RoomModelRef,
  ToolAccess,
} from './types'

export type SummarizeFn = (input: {
  room: Room
  older: RoomMessage[]
  model: RoomModelRef
  signal: AbortSignal
  /** The most the summary may run to, in tokens. */
  maxTokens?: number
}) => Promise<string | null>

export type EngineUpdate =
  | { type: 'room'; room: Room }
  | { type: 'record'; roomId: string; record: RoomJournalRecord }
  | {
      type: 'live'
      roomId: string
      live: LiveTurn | null
      /** On a clear: the one turn that ended. Absent: every live turn of the room. */
      turnId?: string
    }

export type EngineDeps = {
  persistence: RoomPersistence
  streamReply: StreamReply
  now: () => number
  newId: () => string
  /** Overrides the built-in summariser (which calls `streamReply`). */
  summarize?: SummarizeFn
  lookupProvider?: ProviderLookup
  contextWindow?: (model: RoomModelRef) => number
  /**
   * The compaction settings in force (`lib/compaction.ts`): whether older
   * history is summarized (off: it is left out, as a trim), the threshold, and
   * the user's own window, which wins over the model's reported one. Absent:
   * summarized at the default threshold.
   */
  compaction?: (model: RoomModelRef) => {
    enabled: boolean
    threshold?: number
    window?: number | null
    summaryMaxTokens?: number
  }
  /** Backoff wait; resolves false when aborted. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>
  random?: () => number
  onUpdate?: (update: EngineUpdate) => void
  /**
   * Isolated workspaces for compare-room writers (see `isolation.ts`). Absent:
   * writers keep the read-only compare fallback.
   */
  workspace?: RoomWorkspaceDeps
}

export type AbortIntent = 'pause' | 'stop' | 'cancel-turn'

export type RunCommand =
  | { kind: 'discuss' }
  | { kind: 'vote'; proposal: string }
  | { kind: 'final-positions' }
  | { kind: 'synthesize' }
  /**
   * Compare rooms: answer with some participants (null: everyone included).
   * `latest` answers the newest question again; `missing` answers, in order,
   * every question a participant has no answer to yet.
   */
  | { kind: 'compare-run'; participantIds: string[] | null; scope: 'latest' | 'missing' }

export type RunOptions = {
  command?: RunCommand
  /** Why the signal was aborted; read after an abort. Defaults to pause. */
  intent?: () => AbortIntent | null
  /** A user's pending selectNext choice, consumed at the next speaker pick. */
  takeOverride?: () => string | null
  /** User messages sent while the run is active, appended between turns. */
  drainUserMessages?: () => Array<{ text: string; to: Address }>
}

/** Thrown internally once an abort has been recorded. */
export class RunAborted extends Error {
  constructor() {
    super('Aborted')
    this.name = 'AbortError'
  }
}

/** Thrown out of a compare job when a room limit is reached. */
export class LimitStop extends Error {
  constructor(readonly limit: LimitBreach) {
    super('Limit reached')
  }
}

export type TurnOutcome =
  | { kind: 'complete'; message: RoomMessage; raw: string }
  | { kind: 'failed'; message: RoomMessage | null }
  | { kind: 'interrupted'; message: RoomMessage }

export type Finalize = (raw: string) => Partial<RoomMessage>

/** Retries for transient and rate-limited errors (3 attempts in total). */
export const MAX_ATTEMPTS = 3
/** Waiting for a busy local model slot: backoff from 1 s up to 15 s, a minute in all. */
export const BUSY_BACKOFF_START_MS = 1_000
export const BUSY_BACKOFF_MAX_MS = 15_000
export const BUSY_WAIT_MAX_MS = 60_000

/** A pause longer than this between streamed pieces is a wait, not writing. */
export const STREAM_GAP_MS = 2000

/** Tokens per second for a reply, or undefined when too short or quick to mean anything. */
export function writingSpeed(tokens: number, streamedMs: number): number | undefined {
  if (!isMeaningfulSpeed(tokens, streamedMs)) return undefined
  return Math.round((tokens / (streamedMs / 1000)) * 10) / 10
}
export const CONTEXT_MIN_EXTRA_TOKENS = 256

/**
 * What a turn that runs tools is assumed to add to its request before any has
 * been observed: the tool definitions and a couple of results. Replaced by what
 * the participant's own tool turns measured, once there are some.
 */
export const DEFAULT_TOOL_GROWTH_TOKENS: Record<ToolAccess, number> = {
  none: 0,
  read: 3_000,
  edit: 4_000,
  full: 6_000,
}
/** Tool turns kept per participant to estimate how much the next one grows. */
export const GROWTH_SAMPLES = 4
export const CHARS_PER_TOKEN = 3.5

/** A tool call that already ran in an earlier attempt of the turn. */
export type ToolRun = { name: string; args?: unknown }

export type ModelTurnArgs = {
  author: RoomAuthor
  speaker: SpeakerIdentity
  model: RoomModelRef
  kind: RoomMessage['kind']
  instruction: string | null
  participant?: Participant
  finalize?: Finalize
}

/** The retry state of one model turn, carried across its attempts. */
export type TurnAttempts = {
  shrink: boolean
  priorTools: ToolRun[]
  attempt: number
  busyWaitedMs: number
  busyTries: number
  instruction: string | null
  built: BuiltPrompt
}

export type StreamReplyResult = Awaited<ReturnType<EngineDeps['streamReply']>>
