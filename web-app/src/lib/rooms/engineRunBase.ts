import { rt } from './text'
import { estimateTokens } from '@/lib/context-manager'
import { compactionHeadroom } from '@/lib/compaction'
import {
  contextWindowFor,
  defaultProviderLookup,
  preflightParticipants,
  type ProviderLookup,
} from './availability'
import { buildSystemPrompt, isProjectable, type SpeakerIdentity } from './context'
import { checkLimits, clampLimits, breachNote, type LimitBreach } from './limits'
import { toRoomPersistenceError } from './persistence'
import { activeParticipants } from './policy'
import { messagesFromJournal, repairJournal } from './recovery'
import { compareHistory } from './compareGrid'
import {
  ROOM_SCHEMA_VERSION,
  type LiveTurn,
  type Room,
  type RoomJournalRecord,
  type RoomMessage,
  type RoomModelRef,
  type RoomNote,
  type ToolAccess,
} from './types'
import { modelKey, truncate } from './engineText'
import {
  type EngineUpdate,
  type EngineDeps,
  type RunOptions,
  RunAborted,
  CONTEXT_MIN_EXTRA_TOKENS,
  DEFAULT_TOOL_GROWTH_TOKENS,
} from './engineShared'

/**
 * The state a room run holds, its plumbing (persistence, events, limits,
 * context windows) and its lifecycle steps. Model calls are added by
 * `RoomRunTurns` (`engineTurns.ts`), the commands by `RoomRun` (`engine.ts`).
 */
export class RoomRunBase {
  room!: Room
  records: RoomJournalRecord[] = []
  messages: RoomMessage[] = []
  calls = 0
  activeSince: number | null = null
  readonly errorStreaks = new Map<string, number>()
  readonly summaryCache = new Map<string, string>()
  /**
   * Compare rooms: one summary cache per participant. Each one's history holds
   * only the user and itself, so a summary written for one never reaches another.
   */
  readonly compareSummaryCaches = new Map<string, Map<string, string>>()
  /** The live turn in flight, so compaction can flag itself on it. */
  protected activeLive: LiveTurn | null = null
  readonly toolNoted = new Set<string>()
  /** The windows servers named when they refused a request for length. */
  readonly learnedWindows = new Map<string, number>()
  /** Per participant: how far recent tool turns grew past their prompt. */
  readonly toolGrowth = new Map<string, number[]>()
  droppedNoted = false
  /** Compare rooms: participant id -> the question its current turn answers. */
  readonly compareTargets = new Map<string, string>()
  /** Each isolated participant's workspace path this run, made on first use. */
  readonly workspaces = new Map<string, string>()
  readonly lookup: ProviderLookup

  constructor(
    readonly roomId: string,
    readonly deps: EngineDeps,
    readonly signal: AbortSignal,
    readonly opts: RunOptions
  ) {
    this.lookup = deps.lookupProvider ?? defaultProviderLookup
  }

  // ---- plumbing -----------------------------------------------------------

  emit(update: EngineUpdate) {
    try {
      this.deps.onUpdate?.(update)
    } catch (e) {
      console.warn('[rooms] update listener failed', e)
    }
  }

  accrue() {
    if (this.activeSince == null) return
    const t = this.deps.now()
    this.room = {
      ...this.room,
      usage: {
        ...this.room.usage,
        activeMs: this.room.usage.activeMs + Math.max(0, t - this.activeSince),
      },
    }
    this.activeSince = t
  }

  async save(patch: Partial<Room> = {}) {
    this.accrue()
    const next: Room = { ...this.room, ...patch, updatedAt: this.deps.now() }
    try {
      this.room = await this.deps.persistence.saveRoom(next)
    } catch (e) {
      throw toRoomPersistenceError(e)
    }
    this.emit({ type: 'room', room: this.room })
  }

  async append(record: RoomJournalRecord): Promise<RoomJournalRecord> {
    let stored: RoomJournalRecord
    try {
      stored = await this.deps.persistence.appendRoomRecord(this.roomId, record)
    } catch (e) {
      throw toRoomPersistenceError(e)
    }
    this.records.push(stored)
    if (stored.type === 'message') this.messages.push(stored.message)
    this.emit({ type: 'record', roomId: this.roomId, record: stored })
    return stored
  }

  message(partial: Partial<RoomMessage> & Pick<RoomMessage, 'author' | 'kind' | 'text'>): RoomMessage {
    return {
      v: ROOM_SCHEMA_VERSION,
      id: this.deps.newId(),
      roomId: this.roomId,
      seq: 0,
      turnId: null,
      to: { kind: 'room' },
      round: this.room.round,
      createdAt: this.deps.now(),
      status: 'complete',
      ...partial,
      text: truncate(partial.text),
    }
  }

  async appendMessage(m: RoomMessage): Promise<RoomMessage> {
    const stored = await this.append({ type: 'message', message: m })
    return stored.type === 'message' ? stored.message : m
  }

  async system(text: string, note?: RoomNote) {
    const last = this.messages[this.messages.length - 1]
    if (last && last.kind === 'system' && last.text === text) return
    await this.appendMessage(
      this.message({ author: { kind: 'system' }, kind: 'system', text, ...(note ? { note } : {}) })
    )
  }

  /** A system note from `rooms:notes.*`, stored as its key so it is drawn in the current language. */
  async note(key: string, values?: Record<string, string | number>) {
    await this.system(rt(key, values), values ? { key, values } : { key })
  }

  checkAbort() {
    if (this.signal.aborted) throw new RunAborted()
  }

  breach(speaking: boolean): LimitBreach | null {
    return checkLimits(this.room, this.deps.now(), {
      activeSince: this.activeSince,
      callsMade: this.calls,
      speaking,
    })
  }

  maxOutputTokens(): number {
    return clampLimits(this.room.limits).maxOutputTokensPerTurn
  }

  contextWindow(model: RoomModelRef): number {
    // The participant's own model decides: its Max Context Tokens when set.
    const userSet = this.deps.compaction?.(model).window
    const known =
      userSet != null && userSet > 0
        ? userSet
        : (this.deps.contextWindow?.(model) ?? contextWindowFor(model, this.lookup))
    // A server that said what its window really is outranks any setting.
    const learned = this.learnedWindows.get(modelKey(model))
    return learned != null && learned > 0 ? Math.min(known, learned) : known
  }

  /** Remember the window a server named in a refusal for length. */
  learnWindow(model: RoomModelRef, limit: number | null | undefined) {
    if (limit == null || !(limit > 0)) return
    const key = modelKey(model)
    const current = this.learnedWindows.get(key)
    if (current == null || limit < current) this.learnedWindows.set(key, Math.floor(limit))
  }

  /**
   * Seed the summary cache from the dividers already in the journal, so a
   * resumed room builds on the summary it had instead of rereading everything.
   * A divider records how many discussion messages it folded; the summary
   * covers exactly that leading part.
   */
  seedSummaryCache() {
    // A compare room's dividers summarise one participant's own history; the
    // shared cache would hand it to the others.
    if (this.room.mode === 'compare') return
    const projectable = this.messages.filter(isProjectable)
    for (const m of this.messages) {
      const c = m.compaction
      if (!c || !c.summary.trim() || !(c.summarizedCount > 0)) continue
      // Messages at the time the divider was written are a prefix of these.
      const at = projectable[Math.min(c.summarizedCount, projectable.length) - 1]
      if (at && !this.summaryCache.has(at.id)) this.summaryCache.set(at.id, c.summary)
    }
  }

  /** The summary cache a speaker's prompts read and fill. */
  summaryCacheFor(speaker: SpeakerIdentity): Map<string, string> {
    if (this.room.mode !== 'compare' || speaker.kind !== 'participant') return this.summaryCache
    const id = speaker.participant.id
    let cache = this.compareSummaryCaches.get(id)
    if (!cache) {
      cache = new Map()
      this.compareSummaryCaches.set(id, cache)
    }
    return cache
  }

  /** How much the next tool turn of this participant is expected to add. */
  growthHeadroom(participantId: string, access: ToolAccess, window: number): number {
    const samples = this.toolGrowth.get(participantId)
    return compactionHeadroom(
      samples?.length ? samples : [DEFAULT_TOOL_GROWTH_TOKENS[access] / 1.25],
      window
    )
  }

  // ---- lifecycle -----------------------------------------------------------

  async load() {
    const { room, journal } = await this.deps.persistence.getRoom(this.roomId)
    this.room = { ...room, limits: clampLimits(room.limits) }
    this.records = await repairJournal(this.roomId, journal, this.deps.persistence)
    this.messages = messagesFromJournal(this.roomId, this.records)
    this.seedSummaryCache()
  }

  async stopForLimit(limit: LimitBreach) {
    const note = breachNote(limit)
    await this.note(note.key, note.values)
    await this.save({ status: 'stopped', stopReason: { kind: 'limit', limit } })
  }

  async pauseNoParticipants(message: string) {
    await this.system(message)
    await this.save({
      status: 'paused',
      stopReason: { kind: 'no-participants', message },
      nextSpeakerId: null,
    })
  }

  async handleAbort() {
    const intent = this.opts.intent?.() ?? 'pause'
    if (intent === 'stop') {
      await this.note('stoppedByUser')
      await this.save({ status: 'stopped', stopReason: { kind: 'user' } })
    } else {
      await this.note(intent === 'cancel-turn' ? 'turnCancelled' : 'pausedByUser')
      await this.save({ status: 'paused', stopReason: { kind: 'user' } })
    }
  }

  /** Re-check availability. Returns false (after pausing) when too few remain. */
  async preflight(minimum: number): Promise<boolean> {
    const { room, changes } = preflightParticipants(this.room, {
      lookup: this.lookup,
      now: this.deps.now(),
      minimumTokens: (p) =>
        estimateTokens(buildSystemPrompt(this.room, { kind: 'participant', participant: p })) +
        this.maxOutputTokens() +
        CONTEXT_MIN_EXTRA_TOKENS,
      contextWindow: (ref) => this.contextWindow(ref),
    })
    this.room = room
    for (const c of changes) {
      if (c.to.state === 'unavailable') {
        await this.note('unavailableNote', { name: c.participant.name, message: c.to.message })
      } else if (c.from.state === 'unavailable') {
        await this.note('availableAgain', { name: c.participant.name })
      }
    }
    return this.ensureEnough(minimum)
  }

  async ensureEnough(minimum: number): Promise<boolean> {
    const count = activeParticipants(this.room).length
    if (count >= minimum) return true
    await this.pauseNoParticipants(
      minimum >= 2
        ? rt('fewerThanTwo', { count: String(count) })
        : rt('noneAvailablePaused')
    )
    return false
  }

  async drainUserMessages() {
    const pending = this.opts.drainUserMessages?.() ?? []
    for (const m of pending) {
      await this.appendMessage(
        this.message({ author: { kind: 'user' }, kind: 'user', text: m.text, to: m.to })
      )
    }
  }

  /**
   * The messages a prompt is built from. A compare participant sees the
   * questions up to the one it answers, each followed by its own answer, so an
   * answer given later (a replay) sits next to its question.
   */
  historyFor(speaker: SpeakerIdentity): RoomMessage[] {
    if (this.room.mode !== 'compare' || speaker.kind !== 'participant') return this.messages
    const target = this.compareTargets.get(speaker.participant.id) ?? null
    return compareHistory(this.messages, speaker.participant.id, target)
  }
}
