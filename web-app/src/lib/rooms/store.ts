/**
 * `useRoomsStore`: in-memory view of rooms for the UI. Not persisted; the
 * backend files are the source of truth.
 */
import { create } from 'zustand'
import type { EngineUpdate } from './engine'
import { getRoomPersistence, normaliseRoomError } from './persistence'
import { messagesFromJournal } from './recovery'
import type {
  LiveTurn,
  Room,
  RoomError,
  RoomJournalRecord,
  RoomMessage,
  RoomSummary,
} from './types'

export type RoomsState = {
  summaries: RoomSummary[]
  currentRoomId: string | null
  room: Room | null
  journal: RoomJournalRecord[]
  /** Transcript derived from the journal (orphaned turns shown interrupted). */
  messages: RoomMessage[]
  liveTurn: LiveTurn | null
  listLoading: boolean
  roomLoading: boolean
  /** Rooms with an engine run in flight in this app session. */
  runningRoomIds: string[]
  lastError: RoomError | null
  /** The controller action in progress (e.g. 'pause'), for button states. */
  pendingAction: string | null

  loadRooms: () => Promise<void>
  /** Alias of `loadRooms`. */
  loadSummaries: () => Promise<void>
  openRoom: (roomId: string) => Promise<void>
  /** Alias of `openRoom`. */
  loadRoom: (roomId: string) => Promise<void>
  setPendingAction: (action: string | null) => void
  closeRoom: () => void
  applyEngineUpdate: (update: EngineUpdate) => void
  setRunning: (roomId: string, running: boolean) => void
  setError: (error: unknown) => void
  clearError: () => void
  removeRoomLocally: (roomId: string) => void
}

export function summaryOf(room: Room): RoomSummary {
  return {
    id: room.id,
    title: room.title,
    objective: room.objective,
    status: room.status,
    mode: room.mode,
    updatedAt: room.updatedAt,
    createdAt: room.createdAt,
    participantCount: room.participants.filter((p) => !p.removed).length,
    turns: room.usage.turns,
  }
}

function upsertSummary(list: RoomSummary[], summary: RoomSummary): RoomSummary[] {
  const rest = list.filter((s) => s.id !== summary.id)
  return [summary, ...rest].sort((a, b) => b.updatedAt - a.updatedAt)
}

function sameRecord(a: RoomJournalRecord, b: RoomJournalRecord): boolean {
  if (a.type === 'message' && b.type === 'message') return a.message.id === b.message.id
  if (a.type === 'turn-start' && b.type === 'turn-start') return a.turnId === b.turnId
  return false
}

export const useRoomsStore = create<RoomsState>()((set, get) => ({
  summaries: [],
  currentRoomId: null,
  room: null,
  journal: [],
  messages: [],
  liveTurn: null,
  listLoading: false,
  roomLoading: false,
  runningRoomIds: [],
  lastError: null,
  pendingAction: null,

  loadSummaries: () => get().loadRooms(),
  loadRoom: (roomId) => get().openRoom(roomId),
  setPendingAction: (action) => set({ pendingAction: action }),

  loadRooms: async () => {
    set({ listLoading: true })
    try {
      const summaries = await getRoomPersistence().listRooms()
      set({ summaries, listLoading: false })
    } catch (e) {
      set({ listLoading: false, lastError: normaliseRoomError(e) })
    }
  },

  openRoom: async (roomId) => {
    set({
      currentRoomId: roomId,
      roomLoading: true,
      room: null,
      journal: [],
      messages: [],
      liveTurn: null,
    })
    try {
      const { room, journal } = await getRoomPersistence().getRoom(roomId)
      if (get().currentRoomId !== roomId) return
      set({
        room,
        journal,
        messages: messagesFromJournal(roomId, journal),
        roomLoading: false,
        summaries: upsertSummary(get().summaries, summaryOf(room)),
      })
    } catch (e) {
      if (get().currentRoomId !== roomId) return
      set({ roomLoading: false, lastError: normaliseRoomError(e) })
    }
  },

  closeRoom: () =>
    set({ currentRoomId: null, room: null, journal: [], messages: [], liveTurn: null }),

  applyEngineUpdate: (update) => {
    const state = get()
    switch (update.type) {
      case 'room': {
        const patch: Partial<RoomsState> = {
          summaries: upsertSummary(state.summaries, summaryOf(update.room)),
        }
        if (state.currentRoomId === update.room.id) patch.room = update.room
        set(patch)
        return
      }
      case 'record': {
        if (state.currentRoomId !== update.roomId) return
        if (state.journal.some((r) => sameRecord(r, update.record))) return
        const journal = [...state.journal, update.record]
        set({ journal, messages: messagesFromJournal(update.roomId, journal) })
        return
      }
      case 'live': {
        if (update.live) {
          if (state.currentRoomId === update.roomId) set({ liveTurn: update.live })
        } else if (state.liveTurn?.roomId === update.roomId) {
          set({ liveTurn: null })
        }
        return
      }
    }
  },

  setRunning: (roomId, running) => {
    const ids = get().runningRoomIds.filter((id) => id !== roomId)
    set({ runningRoomIds: running ? [...ids, roomId] : ids })
  },

  setError: (error) => set({ lastError: error == null ? null : normaliseRoomError(error) }),
  clearError: () => set({ lastError: null }),

  removeRoomLocally: (roomId) => {
    const state = get()
    set({
      summaries: state.summaries.filter((s) => s.id !== roomId),
      ...(state.currentRoomId === roomId
        ? { currentRoomId: null, room: null, journal: [], messages: [], liveTurn: null }
        : {}),
    })
  },
}))
