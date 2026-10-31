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
  type ProviderLookup,
} from './availability'
import {
  getRoomPersistence,
  normaliseRoomError,
  type RoomPersistence,
} from './persistence'
import { useRoomsStore } from './store'
import {
  loadRoomCompactionPolicy,
  roomCompactionSettingsFor,
} from './compactionSettings'
import {
  DEFAULT_COMPACTION_POLICY,
  type CompactionPolicy,
} from '@/lib/compactionPolicy'
import type { StreamReply } from './callError'
import type { RoomWorkspaceDeps } from './isolation'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import {
  ensureRoomWorkspace,
  markRoomWorkspaceTurn,
  removeRoomWorkspaces,
  roomWorkspaceChanges,
} from '@/services/rooms'
import { roomError } from './participants'
import {
  canResumeOnMessage,
  editorCommands,
  roomCommands,
  runCommands,
  type ControllerContext,
} from './controllerCommands'
export {
  budgetField,
  cleanDisabledTools,
  cleanExtraFolders,
  MAX_EXTRA_FOLDERS,
} from './participants'
import {
  ROOM_LIMIT_CEILINGS,
  ROOM_SCHEMA_VERSION,
  type Address,
  type ModeratorConfig,
  type Participant,
  type Room,
  type RoomController,
  type RoomLimits,
  type RoomToolBudget,
  type RoomMessage,
  type RoomModelRef,
  type SpeakingMode,
  type ToolAccess,
  type CompareRun,
} from './types'

export type ParticipantInput = {
  name: string
  role?: string
  model: RoomModelRef
  toolAccess?: ToolAccess
  pricing?: Participant['pricing']
  reasoning?: Participant['reasoning']
  /** `null` clears it. */
  assistantId?: string | null
  workProfile?: string | null
}

export type CreateRoomInput = {
  title: string
  objective?: string
  mode?: SpeakingMode
  compareRun?: CompareRun
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
  Pick<Participant, 'name' | 'role' | 'model' | 'toolAccess' | 'pricing' | 'order' | 'compareSkip'>
> & {
  /** `null` returns the participant to its model's default reasoning. */
  reasoning?: Participant['reasoning'] | null
  /** `null` clears it. */
  assistantId?: string | null
  workProfile?: Participant['workProfile'] | null
  /** Tools switched off for this participant; `null` or `[]` turns all back on. */
  disabledTools?: string[] | null
}

export type RoomSettingsPatch = {
  /** Per-turn tool budgets; `null` returns to the defaults. */
  toolBudget?: RoomToolBudget | null
  title?: string
  objective?: string
  mode?: SpeakingMode
  compareRun?: CompareRun
  /** The room-wide reasoning effort; `null` returns to each model's default. */
  reasoningEffort?: Room['reasoningEffort'] | null
  moderator?: Partial<ModeratorConfig>
  limits?: Partial<RoomLimits>
  participants?: ParticipantPatch[]
  /** The working folder, or `null` to detach it. */
  folder?: string | null
  /** More folders beside the main one; the list replaces the old one. */
  extraFolders?: string[]
}

export interface RoomEditor {
  createRoom(input: CreateRoomInput): Promise<Room>
  updateRoomSettings(room: Room, patch: RoomSettingsPatch): Promise<Room>
  addParticipant(room: Room, input: ParticipantInput): Promise<Room>
  removeParticipant(room: Room, participantId: string): Promise<Room>
  /** `permanent` skips the archive: the room is gone, not restorable. */
  deleteRoom(roomId: string, opts?: { permanent?: boolean }): Promise<void>
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
  compaction?: EngineDeps['compaction']
  sleep?: EngineDeps['sleep']
  store?: typeof useRoomsStore
  workspace?: RoomWorkspaceDeps
}

/** The backend's isolated workspaces for compare-room writers. */
const defaultRoomWorkspace: RoomWorkspaceDeps = {
  ensure: async (roomId, participantId, folder) => {
    const ws = await ensureRoomWorkspace(roomId, participantId, folder)
    if (!ws || typeof ws.path !== 'string' || !ws.path) throw new Error('no workspace was made')
    return { path: ws.path }
  },
  changes: async (roomId, participantId, scope = 'turn') => {
    const res = await roomWorkspaceChanges(roomId, participantId, scope)
    return Array.isArray(res?.files) ? res.files : []
  },
  markTurn: (roomId, participantId) => markRoomWorkspaceTurn(roomId, participantId),
  remove: (roomId) => removeRoomWorkspaces(roomId),
}

export function defaultNewId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

const defaultStreamReply: StreamReply = async (input) =>
  (await import('./participantModel')).streamParticipantReply(input)

export type RoomSlot = {
  chain: Promise<void>
  run: { controller: AbortController; intent: AbortIntent | null } | null
  override: string | null
  userQueue: Array<{ text: string; to: Address }>
  /** Bumped by every Stop: work queued before it must not start a run after it. */
  stops: number
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
      s = { chain: Promise.resolve(), run: null, override: null, userQueue: [], stops: 0 }
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

  // Read when a run starts (the policy file is async); a run uses one policy.
  let compactionPolicy: CompactionPolicy = DEFAULT_COMPACTION_POLICY
  const engineDeps = (): EngineDeps => ({
    persistence: persistence(),
    streamReply: deps.streamReply ?? defaultStreamReply,
    summarize: deps.summarize,
    now,
    newId,
    lookupProvider: lookup,
    contextWindow: deps.contextWindow,
    compaction:
      deps.compaction ??
      ((model) => roomCompactionSettingsFor(model, lookup, compactionPolicy)),
    sleep: deps.sleep,
    onUpdate: (u) => store().applyEngineUpdate(u),
    workspace: deps.workspace ?? defaultRoomWorkspace,
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
    // Cards held from a pause belong to a run that is gone: a new run asks
    // again for whatever it still needs.
    useToolApprovalRequests.getState().expireHeld(roomId)
    const run = { controller: new AbortController(), intent: null as AbortIntent | null }
    s.run = run
    store().setRunning(roomId, true)
    return enqueue(roomId, async () => {
      try {
        if (guard) {
          const { room } = await persistence().getRoom(roomId)
          if (!guard(room)) return
        }
        if (!deps.compaction) compactionPolicy = await loadRoomCompactionPolicy()
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
          // A Stop that ended (or lands after) this run wins over the messages
          // it left: they are recorded but do not start the room again (R-031).
          const stopsSeen = run.intent === 'stop' ? -1 : s.stops
          let resume = false
          void enqueue(roomId, async () => {
            const { room } = await persistence().getRoom(roomId)
            for (const m of leftovers) {
              await appendMessage(roomId, userMessage(roomId, room.round, m.text, m.to))
            }
            resume = canResumeOnMessage(room, now())
          })
            .then(() => {
              if (resume && s.stops === stopsSeen) {
                void launch(roomId, { kind: 'discuss' }, (r) => r.status !== 'running')
              }
            })
            .catch(reportError)
        }
      }
    })
  }

  /** Abort the active run with an intent and wait for it to settle. */
  const abortRun = async (roomId: string, intent: AbortIntent): Promise<boolean> => {
    const s = slot(roomId)
    if (intent !== 'pause') useToolApprovalRequests.getState().expireHeld(roomId)
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

  const participantDeps = { newId, lookup }

  const refuseWhileRunning = (room: Room) => {
    if (room.status === 'running' || slot(room.id).run) {
      throw roomError('invalid_room', 'Pause or stop the room before editing it.')
    }
  }

  const ctx: ControllerContext = {
    persistence,
    store,
    now,
    newId,
    slot,
    slots,
    enqueue,
    saveRoom,
    appendMessage,
    userMessage,
    launch,
    abortRun,
    guarded,
    setStatusWhenIdle,
    refuseWhileRunning,
    participantDeps,
    workspace: deps.workspace ?? defaultRoomWorkspace,
  }
  const api: RoomControllerApi = {
    ...runCommands(ctx),
    ...editorCommands(ctx),
    ...roomCommands(ctx),
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
