/**
 * The seam between the rooms UI and the rooms engine (docs/DISCUSSION_ROOMS.md).
 *
 * The UI talks only to `RoomsUiApi`. Tests inject a fake through
 * `RoomsApiProvider`. Without a provider, `useRoomsApi` lazily loads the engine
 * modules (`lib/rooms/store.ts`, `lib/rooms/controller.ts`) and adapts them;
 * the UI shows "unavailable" only if loading or adapting fails.
 *
 * Everything that depends on the engine's export and state names is in
 * `adaptEngine` / `adaptState` below (`roomsBindings.engine.test.ts` checks
 * them against the real modules).
 */
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type {
  LiveTurn,
  Participant,
  Room,
  RoomController,
  RoomJournalRecord,
  RoomSummary,
} from '@/lib/rooms/types'

export type RoomsUiError = { code?: string; message: string }

export type RoomsUiState = {
  summaries: RoomSummary[]
  room: Room | null
  journal: RoomJournalRecord[]
  liveTurn: LiveTurn | null
  /** The summaries list is being (re)loaded. */
  listLoading: boolean
  /** A room and its journal are being loaded. */
  roomLoading: boolean
  /** A controller or editor action is in flight; its name, or null. */
  pendingAction: string | null
  lastError: RoomsUiError | null
}

export type CreateRoomInput = { title: string; objective: string }

export type NewParticipantInput = Pick<Participant, 'name' | 'role' | 'model' | 'pricing'> &
  // Optional: omitted, the controller defaults it (read-only for a tool-capable model).
  Partial<Pick<Participant, 'toolAccess'>>

/** Fields only the user may change, through the editor. */
export type RoomSettingsPatch = Partial<
  Pick<Room, 'title' | 'objective' | 'mode' | 'moderator' | 'limits' | 'participants' | 'folder'>
>

export interface RoomsUiApi {
  /** `pending` while the engine modules load; `unavailable` when absent. */
  status: 'ready' | 'pending' | 'unavailable'
  getState(): RoomsUiState
  subscribe(listener: () => void): () => void
  loadSummaries(): Promise<void>
  loadRoom(roomId: string): Promise<void>
  controller: RoomController
  createRoom(input: CreateRoomInput): Promise<Room>
  updateRoomSettings(room: Room, patch: RoomSettingsPatch): Promise<Room>
  addParticipant(room: Room, input: NewParticipantInput): Promise<Room>
  removeParticipant(room: Room, participantId: string): Promise<Room>
  deleteRoom(roomId: string): Promise<void>
  /**
   * Read a room and its journal without opening it (the store's current room
   * is untouched), for overviews such as the rooms list. Optional: an API
   * without it shows summaries only.
   */
  peekRoom?(roomId: string): Promise<{ room: Room; journal: RoomJournalRecord[] }>
}

export const EMPTY_ROOMS_STATE: RoomsUiState = {
  summaries: [],
  room: null,
  journal: [],
  liveTurn: null,
  listLoading: false,
  roomLoading: false,
  pendingAction: null,
  lastError: null,
}

const unavailable = (): Promise<never> =>
  Promise.reject(new Error('Discussion rooms engine is not available'))

function inertApi(status: 'pending' | 'unavailable'): RoomsUiApi {
  const controller: RoomController = {
    start: unavailable,
    pause: unavailable,
    resume: unavailable,
    stop: unavailable,
    selectNext: unavailable,
    sendUserMessage: unavailable,
    extendLimit: unavailable,
    callVote: unavailable,
    requestFinalPositions: unavailable,
    synthesize: unavailable,
    cancelTurn: unavailable,
  }
  return {
    status,
    getState: () => EMPTY_ROOMS_STATE,
    subscribe: () => () => {},
    loadSummaries: unavailable,
    loadRoom: unavailable,
    controller,
    createRoom: unavailable,
    updateRoomSettings: unavailable,
    addParticipant: unavailable,
    removeParticipant: unavailable,
    deleteRoom: unavailable,
  }
}

const PENDING_API = inertApi('pending')
const UNAVAILABLE_API = inertApi('unavailable')

// ---------------------------------------------------------------------------
// Engine adapter. INTEGRATOR: adjust names here if the engine differs.
// ---------------------------------------------------------------------------

type AnyFn = (...args: never[]) => unknown
type EngineStore = {
  getState(): Record<string, unknown>
  subscribe(listener: () => void): () => void
}

export function normalizeError(err: unknown): RoomsUiError | null {
  if (err == null || err === false) return null
  if (typeof err === 'string') return { message: err }
  if (typeof err === 'object' && 'message' in err) {
    const e = err as { message: unknown; code?: unknown }
    return {
      message: String(e.message),
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
    }
  }
  return { message: String(err) }
}

/** Map the engine store's state onto the UI's. Must stay referentially stable. */
function adaptState(s: Record<string, unknown>): RoomsUiState {
  const pending =
    (typeof s.pendingAction === 'string' && s.pendingAction) ||
    (s.busy === true ? 'busy' : null) ||
    (s.actionPending === true ? 'busy' : null)
  return {
    summaries: (s.summaries as RoomSummary[]) ?? [],
    room: (s.room as Room | null) ?? null,
    journal: (s.journal as RoomJournalRecord[]) ?? [],
    liveTurn: (s.liveTurn as LiveTurn | null) ?? null,
    listLoading: Boolean(s.loadingSummaries ?? s.listLoading ?? s.loadingList),
    roomLoading: Boolean(s.loadingRoom ?? s.roomLoading),
    pendingAction: pending || null,
    lastError: normalizeError(s.lastError),
  }
}

export function adaptEngine(exports: Record<string, unknown>): RoomsUiApi | null {
  const store = exports.useRoomsStore as EngineStore | undefined
  const controller = exports.roomController as RoomController | undefined
  if (!store?.getState || !store.subscribe || !controller) return null

  // Actions may live on the store state or be module exports.
  const action = (name: string): AnyFn | undefined => {
    const onState = store.getState()[name]
    if (typeof onState === 'function') return onState as AnyFn
    const exported = exports[name]
    return typeof exported === 'function' ? (exported as AnyFn) : undefined
  }
  const call = async (name: string, ...args: unknown[]): Promise<unknown> => {
    const fn = action(name)
    if (!fn) throw new Error(`Rooms engine does not provide ${name}`)
    return (fn as (...a: unknown[]) => unknown)(...args)
  }
  const roomResult = async (name: string, ...args: unknown[]): Promise<Room> => {
    const result = (await call(name, ...args)) as Room | undefined
    return result ?? (store.getState().room as Room)
  }

  let lastRaw: Record<string, unknown> | null = null
  let lastAdapted: RoomsUiState = EMPTY_ROOMS_STATE
  const getState = () => {
    const raw = store.getState()
    if (raw !== lastRaw) {
      lastRaw = raw
      lastAdapted = adaptState(raw)
    }
    return lastAdapted
  }

  return {
    status: 'ready',
    getState,
    subscribe: (listener) => store.subscribe(() => listener()),
    loadSummaries: async () => {
      await call('loadSummaries')
    },
    loadRoom: async (roomId) => {
      await call('loadRoom', roomId)
    },
    controller,
    createRoom: (input) => roomResult('createRoom', input),
    updateRoomSettings: (room, patch) => roomResult('updateRoomSettings', room, patch),
    addParticipant: (room, input) => roomResult('addParticipant', room, input),
    removeParticipant: (room, id) => roomResult('removeParticipant', room, id),
    deleteRoom: async (roomId) => {
      await call('deleteRoom', roomId)
    },
    ...(typeof exports.getRoomPersistence === 'function'
      ? {
          peekRoom: (roomId: string) =>
            (exports.getRoomPersistence as () => {
              getRoom(id: string): Promise<{ room: Room; journal: RoomJournalRecord[] }>
            })().getRoom(roomId),
        }
      : {}),
  }
}

let engineApi: RoomsUiApi | null = null
let enginePromise: Promise<RoomsUiApi> | null = null

export function loadEngineApi(): Promise<RoomsUiApi> {
  if (!enginePromise) {
    enginePromise = Promise.all([
      import('@/lib/rooms/store'),
      import('@/lib/rooms/controller'),
      import('@/lib/rooms/persistence'),
    ])
      .then((mods) => {
        const merged = Object.assign({}, ...(mods as Record<string, unknown>[]))
        engineApi = adaptEngine(merged) ?? UNAVAILABLE_API
        return engineApi
      })
      .catch((err) => {
        console.error('Failed to load the rooms engine', err)
        engineApi = UNAVAILABLE_API
        return engineApi
      })
  }
  return enginePromise
}

// ---------------------------------------------------------------------------
// React bindings
// ---------------------------------------------------------------------------

const RoomsApiContext = createContext<RoomsUiApi | null>(null)

export function RoomsApiProvider({
  api,
  children,
}: {
  api: RoomsUiApi
  children?: ReactNode
}) {
  return createElement(RoomsApiContext.Provider, { value: api }, children)
}

export function useRoomsApi(): RoomsUiApi {
  const injected = useContext(RoomsApiContext)
  const [loaded, setLoaded] = useState<RoomsUiApi | null>(engineApi)
  useEffect(() => {
    if (injected || loaded) return
    let live = true
    loadEngineApi().then((api) => {
      if (live) setLoaded(api)
    })
    return () => {
      live = false
    }
  }, [injected, loaded])
  return injected ?? loaded ?? PENDING_API
}

export function useRoomsState(): RoomsUiState {
  const api = useRoomsApi()
  return useSyncExternalStore(api.subscribe, api.getState, api.getState)
}
