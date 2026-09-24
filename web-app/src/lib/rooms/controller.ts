/**
 * `roomController`: the actions the UI invokes (the `RoomController` contract)
 * plus room editor helpers.
 *
 * Runs are serialised per room: one engine run at a time, each with its own
 * AbortController. Only these editor helpers (user actions) change settings,
 * participants, tool access, limits or the moderator.
 */
import {
  runRoom,
  type AbortIntent,
  type EngineDeps,
  type RunCommand,
  type SummarizeFn,
} from './engine'
import {
  defaultProviderLookup,
  modelToolSupport,
  type ProviderLookup,
} from './availability'
import { parseAddress } from './addressing'
import { checkLimits, clampLimits, emptyUsage, extendedLimits } from './limits'
import { activeParticipants } from './policy'
import {
  getRoomPersistence,
  normaliseRoomError,
  type RoomPersistence,
} from './persistence'
import { useRoomsStore } from './store'
import type { StreamReply } from './callError'
import {
  DEFAULT_ROOM_LIMITS,
  ROOM_LIMIT_CEILINGS,
  ROOM_SCHEMA_VERSION,
  type Address,
  type ModeratorConfig,
  type Participant,
  type Room,
  type RoomController,
  type RoomError,
  type RoomLimits,
  type RoomMessage,
  type RoomModelRef,
  type SpeakingMode,
  type ToolAccess,
} from './types'

export type ParticipantInput = {
  name: string
  role?: string
  model: RoomModelRef
  toolAccess?: ToolAccess
  pricing?: Participant['pricing']
}

export type CreateRoomInput = {
  title: string
  objective?: string
  mode?: SpeakingMode
  participants?: ParticipantInput[]
  moderator?: Partial<ModeratorConfig>
  limits?: Partial<RoomLimits>
}

/**
 * A participant edit. An `id` matching an existing participant edits it; an
 * entry without a known id (and with name and model) adds a participant.
 * Participants not listed are left unchanged; use `removeParticipant` to remove.
 */
export type ParticipantPatch = { id?: string } & Partial<
  Pick<Participant, 'name' | 'role' | 'model' | 'toolAccess' | 'pricing' | 'order'>
>

export type RoomSettingsPatch = {
  title?: string
  objective?: string
  mode?: SpeakingMode
  moderator?: Partial<ModeratorConfig>
  limits?: Partial<RoomLimits>
  participants?: ParticipantPatch[]
  /** The working folder, or `null` to detach it. */
  folder?: string | null
}

export interface RoomEditor {
  createRoom(input: CreateRoomInput): Promise<Room>
  updateRoomSettings(room: Room, patch: RoomSettingsPatch): Promise<Room>
  addParticipant(room: Room, input: ParticipantInput): Promise<Room>
  removeParticipant(room: Room, participantId: string): Promise<Room>
  deleteRoom(roomId: string): Promise<void>
}

export type RoomControllerApi = RoomController &
  RoomEditor & {
    isRunning(roomId: string): boolean
    /** Resolves once every queued operation for the room has settled. */
    whenIdle(roomId: string): Promise<void>
  }

export type ControllerDeps = {
  persistence?: () => RoomPersistence
  streamReply?: StreamReply
  summarize?: SummarizeFn
  now?: () => number
  newId?: () => string
  lookupProvider?: ProviderLookup
  contextWindow?: EngineDeps['contextWindow']
  sleep?: EngineDeps['sleep']
  store?: typeof useRoomsStore
}

function roomError(code: RoomError['code'], message: string): RoomError {
  return { code, message }
}

/**
 * Whether a user message should make a non-running room pick up and respond,
 * rather than only be recorded. Paused, awaiting-user, completed and
 * user/converged-stopped rooms resume -- but only when continuing would not
 * immediately hit a limit. A room at (or past) a limit is left as it is so the
 * composer can offer to extend it (see `extendLimit`); otherwise it would
 * resume and re-stop in the same instant, swallowing the message.
 */
function canResumeOnMessage(room: Room, now: number): boolean {
  switch (room.status) {
    case 'paused':
    case 'awaiting-user':
    case 'completed':
    case 'stopped':
      break
    default:
      return false
  }
  // The single source of truth for "would continuing help": if no limit blocks,
  // resume; if one does, leave it for the composer's extend prompt. Keying off
  // stopReason instead would strand a limit-stopped room whose limit the user
  // has since raised in the editor -- the message would be swallowed.
  return checkLimits(room, now, { activeSince: now, callsMade: 0, speaking: true }) === null
}

export function defaultNewId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

const defaultStreamReply: StreamReply = async (input) =>
  (await import('./participantModel')).streamParticipantReply(input)

type RoomSlot = {
  chain: Promise<void>
  run: { controller: AbortController; intent: AbortIntent | null } | null
  override: string | null
  userQueue: Array<{ text: string; to: Address }>
}

export function createRoomController(deps: ControllerDeps = {}): RoomControllerApi {
  const persistence = () => (deps.persistence ?? getRoomPersistence)()
  const store = () => (deps.store ?? useRoomsStore).getState()
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? defaultNewId
  const lookup = deps.lookupProvider ?? defaultProviderLookup
  const slots = new Map<string, RoomSlot>()

  const slot = (roomId: string): RoomSlot => {
    let s = slots.get(roomId)
    if (!s) {
      s = { chain: Promise.resolve(), run: null, override: null, userQueue: [] }
      slots.set(roomId, s)
    }
    return s
  }

  /** Serialise an operation after everything already queued for the room. */
  const enqueue = <T>(roomId: string, op: () => Promise<T>): Promise<T> => {
    const s = slot(roomId)
    const result = s.chain.then(op)
    s.chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  const reportError = (e: unknown) => {
    store().setError(e)
  }

  const saveRoom = async (room: Room): Promise<Room> => {
    const saved = await persistence().saveRoom({ ...room, updatedAt: now() })
    store().applyEngineUpdate({ type: 'room', room: saved })
    return saved
  }

  const appendMessage = async (roomId: string, message: RoomMessage) => {
    const record = await persistence().appendRoomRecord(roomId, { type: 'message', message })
    store().applyEngineUpdate({ type: 'record', roomId, record })
  }

  const engineDeps = (): EngineDeps => ({
    persistence: persistence(),
    streamReply: deps.streamReply ?? defaultStreamReply,
    summarize: deps.summarize,
    now,
    newId,
    lookupProvider: lookup,
    contextWindow: deps.contextWindow,
    sleep: deps.sleep,
    onUpdate: (u) => store().applyEngineUpdate(u),
  })

  const userMessage = (roomId: string, round: number, text: string, to: Address): RoomMessage => ({
    v: ROOM_SCHEMA_VERSION,
    id: newId(),
    roomId,
    seq: 0,
    turnId: null,
    author: { kind: 'user' },
    to,
    kind: 'user',
    text: text.slice(0, ROOM_LIMIT_CEILINGS.maxTextLength),
    round,
    createdAt: now(),
    status: 'complete',
  })

  /**
   * Start an engine run unless one is active. `guard` runs inside the queue
   * against the stored room and may veto the run.
   */
  const launch = (
    roomId: string,
    command: RunCommand,
    guard?: (room: Room) => boolean
  ): Promise<void> => {
    const s = slot(roomId)
    if (s.run) return Promise.resolve()
    const run = { controller: new AbortController(), intent: null as AbortIntent | null }
    s.run = run
    store().setRunning(roomId, true)
    return enqueue(roomId, async () => {
      try {
        if (guard) {
          const { room } = await persistence().getRoom(roomId)
          if (!guard(room)) return
        }
        await runRoom(roomId, engineDeps(), run.controller.signal, {
          command,
          intent: () => run.intent,
          takeOverride: () => {
            const o = s.override
            s.override = null
            return o
          },
          drainUserMessages: () => s.userQueue.splice(0),
        })
      } catch (e) {
        reportError(e)
      } finally {
        if (s.run === run) s.run = null
        store().setRunning(roomId, false)
        // Messages sent after the run's last drain are still recorded -- and if
        // the room can act on them, it resumes so they are not left unanswered.
        const leftovers = s.userQueue.splice(0)
        if (leftovers.length) {
          let resume = false
          void enqueue(roomId, async () => {
            const { room } = await persistence().getRoom(roomId)
            for (const m of leftovers) {
              await appendMessage(roomId, userMessage(roomId, room.round, m.text, m.to))
            }
            resume = canResumeOnMessage(room, now())
          })
            .then(() => {
              if (resume) void launch(roomId, { kind: 'discuss' }, (r) => r.status !== 'running')
            })
            .catch(reportError)
        }
      }
    })
  }

  /** Abort the active run with an intent and wait for it to settle. */
  const abortRun = async (roomId: string, intent: AbortIntent): Promise<boolean> => {
    const s = slot(roomId)
    if (!s.run) return false
    s.run.intent = intent
    s.run.controller.abort()
    await s.chain
    return true
  }

  const guarded = async (action: string, op: () => Promise<void>) => {
    store().setPendingAction(action)
    try {
      await op()
    } catch (e) {
      reportError(e)
      throw normaliseRoomError(e)
    } finally {
      if (store().pendingAction === action) store().setPendingAction(null)
    }
  }

  const setStatusWhenIdle = (
    roomId: string,
    decide: (room: Room) => Partial<Room> | null
  ) =>
    enqueue(roomId, async () => {
      const { room } = await persistence().getRoom(roomId)
      const patch = decide(room)
      if (patch) await saveRoom({ ...room, ...patch })
    })

  const refuseWhileRunning = (room: Room) => {
    if (room.status === 'running' || slot(room.id).run) {
      throw roomError('invalid_room', 'Pause or stop the room before editing it.')
    }
  }

  const normaliseParticipant = (
    input: ParticipantInput & { id?: string; order: number; removed?: boolean }
  ): Participant => {
    const name = input.name.trim()
    if (!name) throw roomError('invalid_room', 'A participant needs a name.')
    // A new participant (no toolAccess given) defaults to read-only, so a
    // tool-capable model can use tools the moment the room has a folder or a
    // trusted MCP server -- without that default, every room silently started
    // tool-less and users hit "I have no tools". An explicit 'none' is still
    // honoured. 'read'/'edit' both need a tool-capable model, and any choice is
    // dropped to 'none' when the model has no tools.
    const requested: ToolAccess = input.toolAccess ?? 'read'
    const wantsTools = requested === 'read' || requested === 'edit'
    let pricing: Participant['pricing']
    if (input.pricing) {
      const i = Number(input.pricing.inputPerMTokUsd)
      const o = Number(input.pricing.outputPerMTokUsd)
      if (Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0) {
        pricing = { inputPerMTokUsd: i, outputPerMTokUsd: o }
      }
    }
    return {
      id: input.id ?? newId(),
      name: name.slice(0, 80),
      role: (input.role ?? '').trim().slice(0, 200),
      model: { provider: input.model.provider, id: input.model.id },
      // Forced to none only when the model resolves and truly lacks tools; an
      // unresolved model (provider not loaded yet) keeps the requested access
      // rather than being silently and permanently downgraded. The engine gates
      // tools again at run time, when the model is resolvable.
      toolAccess:
        wantsTools && modelToolSupport(input.model, lookup) !== 'no'
          ? (requested as 'read' | 'edit')
          : 'none',
      removed: input.removed ?? false,
      order: input.order,
      availability: { state: 'unknown' },
      ...(pricing ? { pricing } : {}),
    }
  }

  const validateParticipants = (participants: Participant[]) => {
    if (participants.length > ROOM_LIMIT_CEILINGS.maxParticipants) {
      throw roomError(
        'invalid_room',
        `A room can have at most ${ROOM_LIMIT_CEILINGS.maxParticipants} participants.`
      )
    }
    const seen = new Set<string>()
    for (const p of participants) {
      if (p.removed) continue
      const key = p.name.toLowerCase()
      if (seen.has(key)) {
        throw roomError('invalid_room', `Participant names must be unique ("${p.name}").`)
      }
      seen.add(key)
    }
  }

  const normaliseModerator = (m: Partial<ModeratorConfig> | undefined, prev?: ModeratorConfig): ModeratorConfig => ({
    enabled: m?.enabled ?? prev?.enabled ?? false,
    name: (m?.name ?? prev?.name ?? 'Moderator').trim().slice(0, 80) || 'Moderator',
    model:
      m?.model === undefined
        ? (prev?.model ?? null)
        : m.model
          ? { provider: m.model.provider, id: m.model.id }
          : null,
  })

  const api: RoomControllerApi = {
    isRunning: (roomId) => !!slot(roomId).run,
    whenIdle: async (roomId) => {
      const s = slot(roomId)
      let seen: Promise<void> | null = null
      while (seen !== s.chain) {
        seen = s.chain
        await seen
      }
    },

    start: (roomId) =>
      guarded('start', async () => {
        void launch(roomId, { kind: 'discuss' }, (room) => room.status !== 'running')
      }),

    resume: (roomId) =>
      guarded('resume', async () => {
        void launch(
          roomId,
          { kind: 'discuss' },
          (room) => room.status === 'paused' || room.status === 'awaiting-user'
        )
      }),

    pause: (roomId) =>
      guarded('pause', async () => {
        if (await abortRun(roomId, 'pause')) return
        await setStatusWhenIdle(roomId, (room) =>
          room.status === 'running' || room.status === 'awaiting-user'
            ? { status: 'paused', stopReason: { kind: 'user' } }
            : null
        )
      }),

    stop: (roomId) =>
      guarded('stop', async () => {
        if (await abortRun(roomId, 'stop')) return
        await setStatusWhenIdle(roomId, (room) =>
          room.status === 'stopped' || room.status === 'completed' || room.status === 'draft'
            ? null
            : { status: 'stopped', stopReason: { kind: 'user' } }
        )
      }),

    cancelTurn: (roomId) =>
      guarded('cancelTurn', async () => {
        await abortRun(roomId, 'cancel-turn')
      }),

    selectNext: (roomId, participantId) =>
      guarded('selectNext', async () => {
        const s = slot(roomId)
        if (s.run) {
          s.override = participantId
          return
        }
        let continueRoom = false
        await enqueue(roomId, async () => {
          const { room } = await persistence().getRoom(roomId)
          const target = activeParticipants(room).find((p) => p.id === participantId)
          if (!target) {
            throw roomError('invalid_room', 'That participant cannot speak now.')
          }
          await saveRoom({ ...room, nextSpeakerId: participantId })
          continueRoom = room.mode === 'user-selected' && room.status === 'awaiting-user'
        })
        if (continueRoom) void launch(roomId, { kind: 'discuss' })
      }),

    sendUserMessage: (roomId, text, to) =>
      guarded('sendUserMessage', async () => {
        const body = text.trim()
        if (!body) throw roomError('invalid_room', 'The message is empty.')
        const s = slot(roomId)
        if (s.run) {
          s.userQueue.push({ text: body, to })
          return
        }
        // Whether the room should pick the message up and act on it, rather than
        // just record it. A room stopped by a limit is left alone: resuming it
        // would only re-trip the same limit, so the UI offers to extend instead.
        let resume = false
        await enqueue(roomId, async () => {
          const { room } = await persistence().getRoom(roomId)
          const address =
            to.kind === 'room'
              ? parseAddress(body, room.participants, room.moderator.enabled ? room.moderator.name : null)
              : to
          await appendMessage(roomId, userMessage(roomId, room.round, body, address))
          // In user-selected mode the room waits for the user to pick who speaks
          // next, so a message only resumes when it names a participant (that one
          // answers); a message to everyone/moderator leaves the room waiting.
          if (room.mode === 'user-selected' && room.status === 'awaiting-user') {
            if (address.kind === 'participant') {
              await saveRoom({ ...room, nextSpeakerId: address.participantId })
              resume = true
            }
            return
          }
          resume = canResumeOnMessage(room, now())
        })
        if (resume) void launch(roomId, { kind: 'discuss' }, (room) => room.status !== 'running')
      }),

    extendLimit: (roomId, addRounds, text, to) =>
      guarded('extendLimit', async () => {
        await enqueue(roomId, async () => {
          const { room } = await persistence().getRoom(roomId)
          // Raise every limit together so the room can actually run the extra
          // rounds -- extending one limit by a small count re-trips instantly on
          // the token/time/cost limits or on whatever limit is next.
          const limits = extendedLimits(room, addRounds)
          await saveRoom({ ...room, limits, stopReason: null })
          const body = text?.trim()
          if (body && to) {
            const address =
              to.kind === 'room'
                ? parseAddress(body, room.participants, room.moderator.enabled ? room.moderator.name : null)
                : to
            await appendMessage(roomId, userMessage(roomId, room.round, body, address))
          }
        })
        void launch(roomId, { kind: 'discuss' }, (room) => room.status !== 'running')
      }),

    callVote: (roomId, proposal) =>
      guarded('callVote', async () => {
        const text = proposal.trim()
        if (!text) throw roomError('invalid_room', 'The proposal is empty.')
        await abortRun(roomId, 'pause')
        void launch(roomId, { kind: 'vote', proposal: text })
      }),

    requestFinalPositions: (roomId) =>
      guarded('requestFinalPositions', async () => {
        await abortRun(roomId, 'pause')
        void launch(roomId, { kind: 'final-positions' })
      }),

    synthesize: (roomId) =>
      guarded('synthesize', async () => {
        await abortRun(roomId, 'pause')
        void launch(roomId, { kind: 'synthesize' })
      }),

    // ---- editor ------------------------------------------------------------

    createRoom: async (input) => {
      const title = input.title.trim()
      if (!title) throw roomError('invalid_room', 'A room needs a title.')
      const participants = (input.participants ?? []).map((p, i) =>
        normaliseParticipant({ ...p, order: i })
      )
      validateParticipants(participants)
      const t = now()
      const room: Room = {
        v: ROOM_SCHEMA_VERSION,
        id: newId(),
        title: title.slice(0, 200),
        objective: (input.objective ?? '').trim(),
        status: 'draft',
        mode: input.mode ?? 'round-robin',
        moderator: normaliseModerator(input.moderator),
        participants,
        limits: clampLimits({ ...DEFAULT_ROOM_LIMITS, ...(input.limits ?? {}) }),
        usage: emptyUsage(),
        round: 0,
        spokenThisRound: [],
        nextSpeakerId: null,
        stopReason: null,
        rev: 0,
        createdAt: t,
        updatedAt: t,
      }
      return saveRoom(room)
    },

    // The editor passes the Room it rendered. Each edit re-reads the stored
    // room inside the queue, like selectNext and extendLimit do, so a second
    // edit queued behind the first builds on its result instead of saving
    // against the old rev and failing with stale_revision (#219).
    updateRoomSettings: async (shown, patch) => {
      refuseWhileRunning(shown)
      return enqueue(shown.id, async () => {
        const { room } = await persistence().getRoom(shown.id)
        refuseWhileRunning(room)
        let participants = room.participants
        for (const edit of patch.participants ?? []) {
          const idx = edit.id ? participants.findIndex((p) => p.id === edit.id) : -1
          if (idx < 0) {
            if (!edit.name || !edit.model) {
              throw roomError('invalid_room', 'A new participant needs a name and a model.')
            }
            const order = participants.reduce((m, p) => Math.max(m, p.order + 1), 0)
            participants = [
              ...participants,
              normaliseParticipant({
                name: edit.name,
                role: edit.role,
                model: edit.model,
                toolAccess: edit.toolAccess,
                pricing: edit.pricing,
                order: edit.order ?? order,
              }),
            ]
            continue
          }
          const prev = participants[idx]
          const next = normaliseParticipant({
            id: prev.id,
            name: edit.name ?? prev.name,
            role: edit.role ?? prev.role,
            model: edit.model ?? prev.model,
            toolAccess: edit.toolAccess ?? prev.toolAccess,
            pricing: edit.pricing === undefined ? prev.pricing : edit.pricing,
            order: edit.order ?? prev.order,
            removed: prev.removed,
          })
          participants = participants.map((p, i) => (i === idx ? next : p))
        }
        validateParticipants(participants)
        const updated: Room = {
          ...room,
          title: patch.title !== undefined ? patch.title.trim().slice(0, 200) || room.title : room.title,
          objective: patch.objective !== undefined ? patch.objective.trim() : room.objective,
          mode: patch.mode ?? room.mode,
          moderator: patch.moderator ? normaliseModerator(patch.moderator, room.moderator) : room.moderator,
          folder:
            patch.folder !== undefined ? patch.folder || null : (room.folder ?? null),
          limits: clampLimits({ ...room.limits, ...(patch.limits ?? {}) }),
          // Raising a limit that stopped the room clears the stop, so a message
          // resumes it instead of being stranded by a limit that no longer binds.
          stopReason:
            patch.limits && room.stopReason?.kind === 'limit' ? null : room.stopReason,
          participants,
        }
        return saveRoom(updated)
      })
    },

    addParticipant: async (shown, input) => {
      refuseWhileRunning(shown)
      return enqueue(shown.id, async () => {
        const { room } = await persistence().getRoom(shown.id)
        refuseWhileRunning(room)
        const order = room.participants.reduce((m, p) => Math.max(m, p.order + 1), 0)
        const participants = [...room.participants, normaliseParticipant({ ...input, order })]
        validateParticipants(participants)
        return saveRoom({ ...room, participants })
      })
    },

    removeParticipant: async (shown, participantId) => {
      refuseWhileRunning(shown)
      return enqueue(shown.id, async () => {
        const { room } = await persistence().getRoom(shown.id)
        refuseWhileRunning(room)
        if (!room.participants.some((p) => p.id === participantId)) {
          throw roomError('invalid_room', 'Unknown participant.')
        }
        return saveRoom({
          ...room,
          participants: room.participants.map((p) =>
            p.id === participantId ? { ...p, removed: true } : p
          ),
          spokenThisRound: room.spokenThisRound.filter((id) => id !== participantId),
          nextSpeakerId: room.nextSpeakerId === participantId ? null : room.nextSpeakerId,
        })
      })
    },

    deleteRoom: async (roomId) => {
      await abortRun(roomId, 'stop')
      await enqueue(roomId, async () => {
        await persistence().deleteRoom(roomId)
      })
      slots.delete(roomId)
      store().removeRoomLocally(roomId)
    },
  }
  return api
}

export const roomController: RoomControllerApi = createRoomController()

// Module-level editor actions bound to the default controller.
export const createRoom = (input: CreateRoomInput) => roomController.createRoom(input)
export const updateRoomSettings = (room: Room, patch: RoomSettingsPatch) =>
  roomController.updateRoomSettings(room, patch)
export const addParticipant = (room: Room, input: ParticipantInput) =>
  roomController.addParticipant(room, input)
export const removeParticipant = (room: Room, participantId: string) =>
  roomController.removeParticipant(room, participantId)
export const deleteRoom = (roomId: string) => roomController.deleteRoom(roomId)
export const loadSummaries = () => useRoomsStore.getState().loadSummaries()
export const loadRoom = (roomId: string) => useRoomsStore.getState().loadRoom(roomId)
