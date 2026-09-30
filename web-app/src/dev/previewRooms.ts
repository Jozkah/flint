/**
 * Development-only discussion rooms for the `?preview` seed (see
 * previewSeed.ts): the design mockup's four example rooms and their
 * transcripts, served through the rooms engine's persistence port so the real
 * store, bindings and pages render them. Writes stay in memory.
 */
import { setRoomPersistence, type RoomPersistence } from '@/lib/rooms/persistence'
import { useRoomsStore, summaryOf } from '@/lib/rooms/store'
import { participantColor } from '@/containers/rooms/roomUi'
import {
  DEFAULT_ROOM_LIMITS,
  ROOM_SCHEMA_VERSION,
  type Participant,
  type Room,
  type RoomAuthor,
  type RoomJournalRecord,
  type RoomMessage,
  type RoomStatus,
  type SpeakingMode,
  type ToolAccess,
  type Address,
  type RoomToolActivity,
} from '@/lib/rooms/types'

const MIN = 60_000
const now = Date.now()

// The mockup's participant palette; ids are picked so each participant gets
// the same colour the mockup gives them.
const PCOL = ['#e5484d', '#d6409f', '#8e4ec6', '#3e63dd', '#0091ff', '#12a594', '#46a758', '#e5622d']
function idFor(name: string, colour: number): string {
  for (let n = 0; n < 500; n += 1) {
    const id = `p-${name.toLowerCase()}-${n}`
    if (participantColor(id) === PCOL[colour]) return id
  }
  return `p-${name.toLowerCase()}`
}

type P = [name: string, role: string, provider: string, model: string, access: ToolAccess, colour: number]

function participants(list: P[]): Participant[] {
  return list.map(([name, role, provider, id, toolAccess, colour], order) => ({
    id: idFor(name, colour),
    name,
    role,
    model: { provider, id },
    toolAccess,
    removed: false,
    order,
    availability: { state: 'available' },
    ...(provider === 'anthropic' ? { pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } } : {}),
  }))
}

type Spec = {
  id: string
  title: string
  objective: string
  status: RoomStatus
  mode: SpeakingMode
  turns: number
  rounds: number
  tokens: number
  cost: number | null
  maxCost: number | null
  activeMs: number
  ageMin: number
  folder?: string
  parts: P[]
  moderator?: boolean
}

const SPECS: Spec[] = [
  {
    id: 'arch',
    title: 'Radar feed retry policy',
    objective: 'Decide how acme-weather should retry the upstream radar feed before the 1.4 release.',
    status: 'running',
    mode: 'round-robin',
    turns: 14,
    rounds: 3,
    tokens: 48_200,
    cost: 0.42,
    maxCost: 2,
    activeMs: (6 * 60 + 12) * 1000,
    ageMin: 1,
    folder: 'C:\\Projects\\acme-weather',
    parts: [
      ['Claude', 'skeptic', 'anthropic', 'claude-sonnet-5', 'read', 0],
      ['GPT', 'domain expert', 'openai', 'gpt-5', 'read', 3],
      ['Gemini', 'tester', 'gemini', 'gemini-3-pro', 'edit', 5],
    ],
  },
  {
    id: 'changelog',
    title: 'Changelog wording',
    objective: 'Agree on the tone and length of the acme-weather 1.4 release notes.',
    status: 'awaiting-user',
    mode: 'user-selected',
    turns: 9,
    rounds: 2,
    tokens: 12_800,
    cost: null,
    maxCost: null,
    activeMs: (3 * 60 + 40) * 1000,
    ageMin: 80,
    parts: [
      ['Qwen', 'editor', 'llamacpp', 'qwen3-8b-instruct', 'none', 2],
      ['Mistral', 'copywriter', 'llamacpp', 'Mistral-Small-3.2-24B-Q4_K_S', 'none', 7],
    ],
  },
  {
    id: 'offsets',
    title: 'Sensor calibration check',
    objective: 'Confirm the temperature offset for the rooftop sensor from two independent logs.',
    status: 'completed',
    mode: 'moderator-selected',
    turns: 14,
    rounds: 4,
    tokens: 61_000,
    cost: 0.18,
    maxCost: null,
    activeMs: (11 * 60 + 2) * 1000,
    ageMin: 13 * 60,
    moderator: true,
    parts: [
      ['DeepSeek', 'analyst', 'openrouter', 'deepseek/deepseek-v3.2', 'read', 4],
      ['Grok', 'skeptic', 'openrouter', 'x-ai/grok-4', 'read', 1],
      ['Gemma', 'reviewer', 'llamacpp', 'gemma-3-12b-it-Q5_K_M', 'none', 6],
    ],
  },
  {
    id: 'startup',
    title: 'Dashboard load budget',
    objective: 'Agree on a load-time budget for the weather dashboard and what to lazy-load to meet it.',
    status: 'paused',
    mode: 'round-robin',
    turns: 22,
    rounds: 4,
    tokens: 84_600,
    cost: 0.61,
    maxCost: 2,
    activeMs: (14 * 60 + 5) * 1000,
    ageMin: 5 * 60,
    folder: 'C:\\Projects\\acme-weather',
    parts: [
      ['Opus', 'performance lead', 'anthropic', 'claude-opus-5-5', 'read', 3],
      ['Llama', 'devil’s advocate', 'llamacpp', 'llama-3.1-8b', 'none', 7],
      ['GPT', 'profiler', 'openai', 'gpt-5-mini', 'read', 4],
    ],
  },
  {
    id: 'license',
    title: 'License for the SDK',
    objective: 'Pick a license for the acme-weather client SDK.',
    status: 'stopped',
    mode: 'moderator-selected',
    turns: 8,
    rounds: 2,
    tokens: 19_400,
    cost: null,
    maxCost: null,
    activeMs: (4 * 60 + 18) * 1000,
    ageMin: 2 * 24 * 60,
    moderator: true,
    parts: [
      ['Haiku', 'counsel', 'anthropic', 'claude-haiku-4-5', 'none', 0],
      ['Qwen', 'maintainer', 'llamacpp', 'qwen3-8b-instruct', 'none', 2],
    ],
  },
  {
    id: 'naming',
    title: 'Name the mobile app',
    objective: 'Short, memorable names for the weather app.',
    status: 'draft',
    mode: 'round-robin',
    turns: 0,
    rounds: 0,
    tokens: 0,
    cost: 0,
    maxCost: null,
    activeMs: 0,
    ageMin: 3 * 24 * 60,
    parts: [],
  },
]

function roomOf(s: Spec): Room {
  const parts = participants(s.parts)
  return {
    v: ROOM_SCHEMA_VERSION,
    id: s.id,
    title: s.title,
    objective: s.objective,
    status: s.status,
    mode: s.mode,
    moderator: {
      enabled: !!s.moderator,
      name: 'Moderator',
      model: s.moderator ? { provider: 'anthropic', id: 'claude-haiku-4-5' } : null,
    },
    participants: parts,
    folder: s.folder ?? null,
    limits: { ...DEFAULT_ROOM_LIMITS, maxCostUsd: s.maxCost },
    usage: {
      turns: s.turns,
      rounds: s.rounds,
      inputTokens: Math.round(s.tokens * 0.7),
      outputTokens: s.tokens - Math.round(s.tokens * 0.7),
      estimated: false,
      costUsd: s.cost,
      activeMs: s.activeMs,
      consecutiveRepetitive: 0,
    },
    round: s.rounds,
    spokenThisRound: parts.slice(0, 1).map((p) => p.id),
    nextSpeakerId: parts[1]?.id ?? null,
    stopReason:
      s.status === 'completed'
        ? { kind: 'synthesized' }
        : s.status === 'stopped' || s.status === 'paused'
          ? { kind: 'user' }
          : null,
    rev: 1,
    createdAt: now - (s.ageMin + 60) * MIN,
    updatedAt: now - s.ageMin * MIN,
  }
}

type M = {
  by?: string
  you?: boolean
  mod?: boolean
  sys?: boolean
  kind?: RoomMessage['kind']
  to?: Address
  text: string
  tools?: RoomToolActivity[]
  vote?: RoomMessage['vote']
  dissent?: RoomMessage['dissent']
  disagreements?: string[]
}

function journalOf(room: Room, list: M[]): RoomJournalRecord[] {
  const start = room.updatedAt - list.length * 2 * MIN
  let callId = ''
  return list.map((m, i): RoomJournalRecord => {
    const p = m.by ? room.participants.find((x) => x.name === m.by) : undefined
    const author: RoomAuthor = m.sys
      ? { kind: 'system' }
      : m.you
        ? { kind: 'user' }
        : m.mod
          ? { kind: 'moderator', name: 'Moderator' }
          : { kind: 'participant', participantId: p!.id, name: p!.name }
    const id = `${room.id}-m${i + 1}`
    const kind = m.kind ?? (m.sys ? 'system' : m.you ? 'user' : m.mod ? 'moderator-note' : 'speech')
    if (kind === 'vote-call') callId = id
    const vote = m.vote ? { ...m.vote, callId } : undefined
    return {
      type: 'message',
      message: {
        v: ROOM_SCHEMA_VERSION,
        id,
        roomId: room.id,
        seq: i + 1,
        turnId: p ? `${id}-turn` : null,
        author,
        to: m.to ?? { kind: 'room' },
        kind,
        text: m.text,
        round: Math.max(1, Math.ceil(((i + 1) / list.length) * room.usage.rounds)),
        createdAt: start + i * 2 * MIN,
        status: 'complete',
        ...(m.tools ? { toolCalls: m.tools } : {}),
        ...(vote ? { vote } : {}),
        ...(m.dissent ? { dissent: m.dissent } : {}),
        ...(m.disagreements
          ? {
              directive: {
                next: 'DeepSeek',
                request: null,
                disagreements: m.disagreements,
                converged: false,
                stop: false,
                reason: '',
              },
            }
          : {}),
      },
    }
  })
}

const proposal = 'Retry 3 times with jittered backoff, then serve the cached frame, and add a timeout test before 1.4.'

const TRANSCRIPTS: Record<string, (room: Room) => M[]> = {
  arch: () => [
    { sys: true, text: 'Room started · Round-robin · 3 participants' },
    { you: true, text: 'Keep it short, we cut 1.4 on Friday. When the radar feed times out, how hard should we retry?' },
    { by: 'Claude', text: 'Not hard. Every retry holds a request open, and the feed usually recovers within a minute. A stale frame is better than a spinner. @GPT how often does it actually fail?' },
    {
      by: 'GPT',
      tools: [
        { name: 'web_search', ok: true, args: { query: 'exponential backoff jitter best practice' }, output: '4 results' },
        { name: 'read_file', ok: true, args: { path: 'logs/radar-2026-09.jsonl' }, output: '8,412 lines' },
      ],
      text: 'From September’s logs: 2.4% of radar fetches timed out, and 88% of those succeeded on the second or third try. Three retries with jitter cover almost all of it. @Gemini can you check the tests?',
    },
    {
      by: 'Gemini',
      tools: [
        { name: 'read_file', ok: true, args: { path: 'internal/radar/client_test.go' }, output: '9 tests' },
        { name: 'run_tests', ok: false, args: { filter: 'TestRadarRetry' }, output: 'Refused: needs approval, and approvals never apply in rooms' },
      ],
      text: 'There are 9 client tests and none cover a timeout followed by a cached fallback. I couldn’t run them from here, since running tests needs approval.',
    },
    { you: true, kind: 'vote-call', text: proposal },
    { by: 'Claude', kind: 'vote', vote: { callId: '', choice: 'agree', proposal }, text: 'Agree. Bounded retries, then the cache.' },
    { by: 'GPT', kind: 'vote', vote: { callId: '', choice: 'agree', proposal }, text: 'Agree, with a metric so we can see how often the fallback fires.' },
    { by: 'Gemini', kind: 'vote', vote: { callId: '', choice: 'disagree', proposal }, text: 'Disagree until the timeout test exists. I’d hold the release a day.' },
    { by: 'Claude', to: { kind: 'user' }, text: '@you If we ship Friday, I’d put GPT’s metric behind a flag so we can turn it off if it’s noisy.' },
  ],
  changelog: () => [
    { sys: true, text: 'Room started · You choose · 2 participants' },
    { by: 'Qwen', text: 'Proposal: one line per change, grouped under Added / Fixed / Changed.' },
    { by: 'Mistral', text: 'I’d lead with the three user-visible wins, then the list. @Qwen shorter lines are fine.' },
    { sys: true, text: 'Waiting for you to choose the next speaker.' },
  ],
  offsets: (room) => [
    { sys: true, text: 'Room started · Moderator chooses · 3 participants' },
    {
      mod: true,
      text: 'The two logs disagree on the offset. @DeepSeek go first.',
      disagreements: ['Offset: −0.8 °C vs −1.1 °C', 'Whether humidity needs its own correction'],
    },
    { by: 'DeepSeek', text: 'Both logs agree on −0.8 °C at night. The −1.1 °C readings are all between 12:00 and 15:00, when the enclosure sits in direct sun.' },
    { by: 'Grok', kind: 'final-position', text: 'Agree on −0.8 °C. The midday error is heat, not calibration.' },
    {
      mod: true,
      kind: 'synthesis',
      text: 'Offset: −0.8 °C (agreed). Midday readings run hot from sun on the enclosure; add a radiation shield before changing the offset.',
      dissent: [
        {
          participantId: room.participants.find((p) => p.name === 'Grok')!.id,
          name: 'Grok',
          position: 'Humidity may still need its own correction.',
        },
      ],
    },
  ],
  startup: () => [
    { sys: true, text: 'Room started · Round-robin · 3 participants' },
    { by: 'Opus', text: 'The dashboard takes 2.9 s to first paint on a mid-range phone. I’d set the budget at 1.5 s and lazy-load the radar map and the charts.' },
    { by: 'Llama', text: 'A budget nobody measures in CI will drift back. Put the number in a test first.' },
    { by: 'GPT', tools: [{ name: 'read_file', ok: true, args: { path: 'web/dist/stats.json' }, output: '96 chunks' }], text: 'The map library alone is 41% of the initial bundle. Moving it behind the radar tab gets us to about 1.7 s.' },
    { sys: true, text: 'Paused by you.' },
  ],
  license: () => [
    { sys: true, text: 'Room started · Moderator chooses · 2 participants' },
    { by: 'Haiku', text: 'Apache-2.0 keeps it permissive and adds a patent grant, which company users tend to ask for.' },
    { by: 'Qwen', text: 'Agreed. Keep third-party notices in a NOTICE file.' },
    { sys: true, text: 'Stopped by you.' },
  ],
  naming: () => [],
}

const LIVE_TEXT =
  'I can add the metric as a flag in `config.Radar`, off by default. It counts each fallback with the age of the cached frame, so we can see how stale the map gets. @Gemini once the timeout test lands I’ll rerun the numbers.'

export function seedRooms() {
  const rooms = new Map<string, Room>()
  const journals = new Map<string, RoomJournalRecord[]>()
  for (const s of SPECS) {
    const room = roomOf(s)
    rooms.set(room.id, room)
    journals.set(room.id, journalOf(room, TRANSCRIPTS[room.id](room)))
  }

  const persistence: RoomPersistence = {
    listRooms: async () =>
      [...rooms.values()].map(summaryOf).sort((a, b) => b.updatedAt - a.updatedAt),
    getRoom: async (roomId) => {
      const room = rooms.get(roomId)
      if (!room) throw { code: 'not_found', message: `Room ${roomId} not found` }
      return { room, journal: journals.get(roomId) ?? [] }
    },
    saveRoom: async (room) => {
      const saved = { ...room, rev: room.rev + 1, updatedAt: Date.now() }
      rooms.set(saved.id, saved)
      if (!journals.has(saved.id)) journals.set(saved.id, [])
      return saved
    },
    appendRoomRecord: async (roomId, record) => {
      journals.set(roomId, [...(journals.get(roomId) ?? []), record])
      return record
    },
    clearRoomJournal: async (roomId) => {
      journals.set(roomId, [])
    },
    deleteRoom: async (roomId) => {
      rooms.delete(roomId)
      journals.delete(roomId)
    },
  }
  setRoomPersistence(persistence)

  // The running room shows GPT's turn streaming in, as the mockup does. The
  // store clears the live turn whenever a room opens, so it is set again once
  // the running room has loaded.
  let streaming: ReturnType<typeof setInterval> | null = null
  useRoomsStore.subscribe((state, prev) => {
    const room = state.room
    if (!room || room === prev.room || room.status !== 'running' || state.liveTurn) return
    const speaker = room.participants.find((p) => p.id === room.nextSpeakerId)
    if (!speaker) return
    const words = LIVE_TEXT.split(' ')
    let n = 0
    const live = {
      roomId: room.id,
      turnId: `${room.id}-live`,
      author: { kind: 'participant', participantId: speaker.id, name: speaker.name } as RoomAuthor,
      text: '',
      startedAt: Date.now(),
    }
    if (streaming) clearInterval(streaming)
    useRoomsStore.setState({ liveTurn: live })
    streaming = setInterval(() => {
      const cur = useRoomsStore.getState()
      if (cur.liveTurn?.turnId !== live.turnId) {
        if (streaming) clearInterval(streaming)
        return
      }
      n = Math.min(words.length, n + 1)
      useRoomsStore.setState({ liveTurn: { ...live, text: words.slice(0, n).join(' ') } })
      if (n >= words.length && streaming) clearInterval(streaming)
    }, 90)
  })
}
