/* eslint-disable react-refresh/only-export-components */
import { vi } from 'vitest'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import rooms from '@/locales/en/rooms.json'
import {
  DEFAULT_ROOM_LIMITS,
  ROOM_SCHEMA_VERSION,
  type Participant,
  type Room,
  type RoomJournalRecord,
  type RoomMessage,
} from '@/lib/rooms/types'
import {
  EMPTY_ROOMS_STATE,
  RoomsApiProvider,
  type RoomsUiApi,
  type RoomsUiState,
} from '../roomsBindings'

/** Real `rooms` strings with `{{var}}` interpolation, so tests read like the UI. */
export function t(key: string, options: Record<string, unknown> = {}): string {
  const [ns, path] = key.includes(':') ? key.split(':') : ['common', key]
  if (ns !== 'rooms') return key
  const value = path
    .split('.')
    .reduce<unknown>((cur, part) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined), rooms)
  if (typeof value !== 'string') return key
  return value.replace(/\{\{(\w+)\}\}/g, (m, v) => (options[v] !== undefined ? String(options[v]) : m))
}

export const testProviders = [
  {
    provider: 'openai',
    active: true,
    api_key: 'test-key',
    settings: [],
    models: [
      { id: 'tool-model', name: 'Tool Model', capabilities: ['tools'] },
      { id: 'plain-model', name: 'Plain Model', capabilities: [] },
      { id: 'embed-model', name: 'Embed', embedding: true },
    ],
  },
]

export function makeParticipant(id: string, overrides: Partial<Participant> = {}): Participant {
  return {
    id,
    name: id,
    role: '',
    model: { provider: 'openai', id: 'tool-model' },
    toolAccess: 'none',
    removed: false,
    order: 0,
    availability: { state: 'available' },
    ...overrides,
  }
}

export function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    v: ROOM_SCHEMA_VERSION,
    id: 'r1',
    title: 'Alpha',
    objective: 'Decide things',
    status: 'draft',
    mode: 'round-robin',
    moderator: { enabled: false, name: 'Mod', model: null },
    participants: [
      makeParticipant('p1', { name: 'Alice', role: 'skeptic', order: 0 }),
      makeParticipant('p2', { name: 'Bob', role: 'expert', order: 1 }),
    ],
    limits: { ...DEFAULT_ROOM_LIMITS },
    usage: {
      turns: 0,
      rounds: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimated: false,
      costUsd: null,
      activeMs: 0,
      consecutiveRepetitive: 0,
    },
    round: 0,
    spokenThisRound: [],
    nextSpeakerId: null,
    stopReason: null,
    rev: 1,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

let seq = 0
export function makeMessage(overrides: Partial<RoomMessage> = {}): RoomMessage {
  seq += 1
  return {
    v: ROOM_SCHEMA_VERSION,
    id: `m${seq}`,
    roomId: 'r1',
    seq,
    turnId: null,
    author: { kind: 'participant', participantId: 'p1', name: 'Alice' },
    to: { kind: 'room' },
    kind: 'speech',
    text: 'hello',
    round: 1,
    createdAt: seq,
    status: 'complete',
    ...overrides,
  }
}

export const asJournal = (messages: RoomMessage[]): RoomJournalRecord[] =>
  messages.map((message) => ({ type: 'message', message }))

export function createFakeApi(initial: Partial<RoomsUiState> = {}) {
  let state: RoomsUiState = { ...EMPTY_ROOMS_STATE, ...initial }
  const listeners = new Set<() => void>()
  const set = (patch: Partial<RoomsUiState>) => {
    state = { ...state, ...patch }
    listeners.forEach((l) => l())
  }
  const ok = () => vi.fn().mockResolvedValue(undefined)
  const controller = {
    start: ok(),
    pause: ok(),
    resume: ok(),
    stop: ok(),
    selectNext: ok(),
    sendUserMessage: ok(),
    callVote: ok(),
    requestFinalPositions: ok(),
    synthesize: ok(),
    cancelTurn: ok(),
  }
  const api = {
    status: 'ready' as const,
    getState: () => state,
    subscribe: (l: () => void) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    loadSummaries: ok(),
    loadRoom: ok(),
    controller,
    createRoom: vi.fn(async (input: { title: string }) => makeRoom({ id: 'new1', title: input.title })),
    updateRoomSettings: vi.fn(async (room: Room) => room),
    addParticipant: vi.fn(async (room: Room) => room),
    removeParticipant: vi.fn(async (room: Room) => room),
    deleteRoom: ok(),
  }
  return { api: api as typeof api & RoomsUiApi, controller, set }
}

export function renderWithApi(ui: ReactElement, api: RoomsUiApi) {
  return render(<RoomsApiProvider api={api}>{ui}</RoomsApiProvider>)
}
