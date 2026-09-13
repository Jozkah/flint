import type { EngineDeps } from '../engine'
import type { StreamReplyInput, StreamReplyResult } from '../callError'
import type { RoomPersistence } from '../persistence'
import { DEFAULT_ROOM_LIMITS, ROOM_SCHEMA_VERSION } from '../types'
import type {
  Participant,
  Room,
  RoomJournalRecord,
  RoomLimits,
  RoomMessage,
  RoomSummary,
} from '../types'
import { emptyUsage } from '../limits'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/** In-memory persistence with the backend's rev, seq and idempotency rules. */
export function memoryPersistence() {
  const rooms = new Map<string, Room>()
  const journals = new Map<string, RoomJournalRecord[]>()
  const p: RoomPersistence & {
    rooms: Map<string, Room>
    journals: Map<string, RoomJournalRecord[]>
  } = {
    rooms,
    journals,
    async listRooms(): Promise<RoomSummary[]> {
      return [...rooms.values()]
        .map((r) => ({
          id: r.id,
          title: r.title,
          objective: r.objective,
          status: r.status,
          mode: r.mode,
          updatedAt: r.updatedAt,
          createdAt: r.createdAt,
          participantCount: r.participants.filter((x) => !x.removed).length,
          turns: r.usage.turns,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },
    async getRoom(roomId) {
      const room = rooms.get(roomId)
      if (!room) throw { code: 'not_found', message: 'no room' }
      return { room: clone(room), journal: clone(journals.get(roomId) ?? []) }
    },
    async saveRoom(room) {
      const existing = rooms.get(room.id)
      const storedRev = existing ? existing.rev : 0
      if (room.rev !== storedRev) throw { code: 'stale_revision', message: 'stale' }
      const saved = clone({ ...room, rev: storedRev + 1 })
      rooms.set(room.id, saved)
      if (!journals.has(room.id)) journals.set(room.id, [])
      return clone(saved)
    },
    async appendRoomRecord(roomId, record) {
      const journal = journals.get(roomId)
      if (!journal) throw { code: 'not_found', message: 'no room' }
      if (record.type === 'message') {
        const dup = journal.find(
          (r) => r.type === 'message' && r.message.id === record.message.id
        )
        if (dup) return clone(dup)
        const seq =
          journal.reduce((m, r) => (r.type === 'message' ? Math.max(m, r.message.seq) : m), 0) + 1
        const stored: RoomJournalRecord = {
          type: 'message',
          message: { ...clone(record.message), seq },
        }
        journal.push(stored)
        return clone(stored)
      }
      journal.push(clone(record))
      return clone(record)
    },
    async deleteRoom(roomId) {
      rooms.delete(roomId)
      journals.delete(roomId)
    },
  }
  return p
}

export function participant(
  id: string,
  name: string,
  provider: string,
  model: string,
  over: Partial<Participant> = {}
): Participant {
  return {
    id,
    name,
    role: '',
    model: { provider, id: model },
    toolAccess: 'none',
    removed: false,
    order: 0,
    availability: { state: 'unknown' },
    ...over,
  }
}

export function makeRoom(over: Partial<Room> & { limits?: Partial<RoomLimits> } = {}): Room {
  const participants = over.participants ?? [
    participant('p-a', 'Alice', 'provider-a', 'model-1', { order: 0, role: 'optimist' }),
    participant('p-b', 'Bob', 'provider-b', 'model-2', { order: 1, role: 'skeptic' }),
  ]
  return {
    v: ROOM_SCHEMA_VERSION,
    id: 'room-1',
    title: 'Test room',
    objective: 'Decide on the plan',
    status: 'draft',
    mode: 'round-robin',
    moderator: { enabled: false, name: 'Moderator', model: null },
    rev: 0,
    createdAt: 1,
    updatedAt: 1,
    round: 0,
    spokenThisRound: [],
    nextSpeakerId: null,
    stopReason: null,
    usage: emptyUsage(),
    ...over,
    participants,
    limits: { ...DEFAULT_ROOM_LIMITS, ...(over.limits ?? {}) },
  }
}

export function makeProvider(name: string, models: Array<string | Partial<Model>>, over: Partial<ModelProvider> = {}): ModelProvider {
  return {
    active: true,
    provider: name,
    settings: [],
    models: models.map((m) => (typeof m === 'string' ? { id: m } : ({ id: 'x', ...m } as Model))),
    ...over,
  }
}

export function providerLookup(providers: ModelProvider[]) {
  return (name: string) => providers.find((p) => p.provider === name)
}

export const defaultProviders = () => [
  makeProvider('provider-a', [{ id: 'model-1', capabilities: ['tools'] }]),
  makeProvider('provider-b', ['model-2']),
  makeProvider('provider-c', ['model-3']),
]

export async function seedRoom(p: ReturnType<typeof memoryPersistence>, room: Room) {
  p.rooms.set(room.id, clone({ ...room, rev: room.rev }))
  if (!p.journals.has(room.id)) p.journals.set(room.id, [])
}

export async function seedMessages(
  p: ReturnType<typeof memoryPersistence>,
  roomId: string,
  texts: Array<{ author: RoomMessage['author']; text: string; kind?: RoomMessage['kind'] }>
) {
  let i = 0
  for (const t of texts) {
    await p.appendRoomRecord(roomId, {
      type: 'message',
      message: {
        v: ROOM_SCHEMA_VERSION,
        id: `seed-${i++}`,
        roomId,
        seq: 0,
        turnId: null,
        author: t.author,
        to: { kind: 'room' },
        kind: t.kind ?? (t.author.kind === 'user' ? 'user' : 'speech'),
        text: t.text,
        round: 1,
        createdAt: i,
        status: 'complete',
      },
    })
  }
}

/** Name of the speaker a prompt was built for. */
export function speakerOf(input: StreamReplyInput): string {
  const m = input.system.match(/^You are (.+?)(?: \([^)]*\))?, (?:a participant|the moderator)/)
  return m ? m[1] : '?'
}

export function isModeratorPrompt(input: StreamReplyInput): boolean {
  return /the moderator of a multi-party discussion/.test(input.system)
}

export function lastContent(input: StreamReplyInput): string {
  return input.messages[input.messages.length - 1]?.content ?? ''
}

let wordSeed = 0
/** Text that never repeats earlier turns (unique words, no shared shingles). */
export function uniqueText(): string {
  const words: string[] = []
  for (let i = 0; i < 12; i++) words.push(`w${wordSeed++}x`)
  return words.join(' ')
}

export type Scripted = (
  input: StreamReplyInput,
  index: number
) => Partial<StreamReplyResult> & { error?: unknown; chunks?: string[] } | Promise<Partial<StreamReplyResult> & { error?: unknown; chunks?: string[] }>

export function scriptedStream(script: Scripted, clock?: { t: number; step: number }) {
  const calls: StreamReplyInput[] = []
  const fn = async (input: StreamReplyInput): Promise<StreamReplyResult> => {
    const index = calls.length
    calls.push({ ...input, messages: input.messages.map((m) => ({ ...m })) })
    if (clock) clock.t += clock.step
    const out = await script(input, index)
    for (const c of out.chunks ?? []) input.onText(c)
    if (out.error) throw out.error
    const text = out.text ?? (out.chunks ?? []).join('')
    if (!out.chunks && text) input.onText(text)
    return { text, usage: out.usage, finishReason: out.finishReason ?? 'stop' }
  }
  return { fn, calls }
}

export function engineDeps(
  persistence: RoomPersistence,
  streamReply: EngineDeps['streamReply'],
  over: Partial<EngineDeps> & { clock?: { t: number } } = {}
): EngineDeps {
  let id = 0
  const clock = over.clock ?? { t: 1_000 }
  return {
    persistence,
    streamReply,
    now: () => clock.t,
    newId: () => `id-${++id}`,
    lookupProvider: providerLookup(defaultProviders()),
    contextWindow: () => 32_000,
    sleep: async () => true,
    random: () => 0,
    ...over,
  }
}

export function messagesOf(p: ReturnType<typeof memoryPersistence>, roomId = 'room-1'): RoomMessage[] {
  return (p.journals.get(roomId) ?? [])
    .filter((r): r is Extract<RoomJournalRecord, { type: 'message' }> => r.type === 'message')
    .map((r) => r.message)
}

export function abortError(): Error {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}
