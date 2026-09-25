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
    title: 'Architecture review',
    objective: 'Decide how conservative the tool-argument recovery pass should be before 0.9.0 ships.',
    status: 'running',
    mode: 'round-robin',
    turns: 14,
    rounds: 3,
    tokens: 48_200,
    cost: 0.42,
    maxCost: 2,
    activeMs: (6 * 60 + 12) * 1000,
    ageMin: 1,
    folder: 'C:\\Users\\Jozkah\\Desktop\\Coding\\jan',
    parts: [
      ['Claude', 'skeptic', 'anthropic', 'claude-sonnet-5', 'read', 0],
      ['GPT', 'domain expert', 'openai', 'gpt-5', 'read', 3],
      ['Gemini', 'tester', 'gemini', 'gemini-3-pro', 'edit', 5],
    ],
  },
  {
    id: 'changelog',
    title: 'Changelog wording',
    objective: 'Agree on the tone and length of the 0.9.0 release notes.',
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
      ['Qwen', 'editor', 'llamacpp', 'Qwen3-14B-Q4_K_M', 'none', 2],
      ['Mistral', 'copywriter', 'llamacpp', 'Mistral-Small-3.2-24B-Q4_K_S', 'none', 7],
    ],
  },
  {
    id: 'offsets',
    title: 'Offset cross-check',
    objective: 'Confirm the health and position offsets from two independent dumps.',
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
    title: 'Startup time budget',
    objective: 'Agree on a cold-start budget for the desktop app and what to lazy-load to meet it.',
    status: 'paused',
    mode: 'round-robin',
    turns: 22,
    rounds: 4,
    tokens: 84_600,
    cost: 0.61,
    maxCost: 2,
    activeMs: (14 * 60 + 5) * 1000,
    ageMin: 5 * 60,
    folder: 'C:\\Users\\Jozkah\\Desktop\\Coding\\jan',
    parts: [
      ['Opus', 'performance lead', 'anthropic', 'claude-opus-5-5', 'read', 3],
      ['Llama', 'devil’s advocate', 'llamacpp', 'Llama-4-Scout-17B-Q3_K_M', 'none', 7],
      ['GPT', 'profiler', 'openai', 'gpt-5-mini', 'read', 4],
    ],
  },
  {
    id: 'license',
    title: 'License for the fork',
    objective: 'Pick a license that keeps upstream compatibility and allows the bundled models.',
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
      ['Qwen', 'maintainer', 'llamacpp', 'Qwen3-14B-Q4_K_M', 'none', 2],
    ],
  },
  {
    id: 'naming',
    title: 'Name the app',
    objective: 'Short, memorable names for the Flint fork.',
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

const proposal = 'Ship the conservative pass for 0.9.0 and add UNC tests before release.'

const TRANSCRIPTS: Record<string, (room: Room) => M[]> = {
  arch: () => [
    { sys: true, text: 'Room started · Round-robin · 3 participants' },
    { you: true, text: 'Keep it short, we ship Friday. Should the recovery pass fix anything it can, or only what it can prove?' },
    { by: 'Claude', text: 'Only what it can prove. A wrong “fix” silently changes a file path, which is worse than an error the model can retry. @GPT do you have numbers on how often this happens?' },
    {
      by: 'GPT',
      tools: [
        { name: 'web_search', ok: true, args: { query: 'json escape windows path tool call' }, output: '4 results' },
        { name: 'read_file', ok: true, args: { path: 'logs/tool-calls-2026-09.jsonl' }, output: '11,842 lines' },
      ],
      text: 'From September’s logs: 3.1% of tool calls had bad escapes, and 92% of those were Windows paths like `C:\\Users`. Those are safe to repair. @Gemini can you check test coverage?',
    },
    {
      by: 'Gemini',
      tools: [
        { name: 'read_file', ok: true, args: { path: 'src/agent/tests/recover.rs' }, output: '14 tests' },
        { name: 'run_tests', ok: false, args: { filter: 'recover_args' }, output: 'Refused: needs approval, and approvals never apply in rooms' },
      ],
      text: 'There are 14 recovery tests and none cover UNC paths such as `\\\\server\\share`. I couldn’t run them from here, since running tests needs approval.',
    },
    { you: true, kind: 'vote-call', text: proposal },
    { by: 'Claude', kind: 'vote', vote: { callId: '', choice: 'agree', proposal }, text: 'Agree. Conservative is the right default.' },
    { by: 'GPT', kind: 'vote', vote: { callId: '', choice: 'agree', proposal }, text: 'Agree, with a counter so we can see how often it fires.' },
    { by: 'Gemini', kind: 'vote', vote: { callId: '', choice: 'disagree', proposal }, text: 'Disagree until the UNC tests exist. I’d hold the release a day.' },
    { by: 'Claude', to: { kind: 'user' }, text: '@you If we ship Friday, I’d put GPT’s counter behind a flag so we can turn it off if it’s noisy.' },
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
      text: 'Two dumps disagree on the rotation offset. @DeepSeek go first.',
      disagreements: ['Rotation: 0x1B0 vs 0x1B4', 'Whether the health field is a float or an int'],
    },
    { by: 'DeepSeek', text: 'Health is a float at 0x1A8 in both dumps. Rotation is 0x1B4; the 0x1B0 read is the padding before it.' },
    { by: 'Grok', kind: 'final-position', text: 'Agree on 0x1A8. Still unsure on rotation without a third sample.' },
    {
      mod: true,
      kind: 'synthesis',
      text: 'Health: float at 0x1A8 (agreed). Rotation: 0x1B4 (majority). Take a third dump before relying on rotation.',
      dissent: [
        {
          participantId: room.participants.find((p) => p.name === 'Grok')!.id,
          name: 'Grok',
          position: 'Rotation offset needs a third sample.',
        },
      ],
    },
  ],
  startup: () => [
    { sys: true, text: 'Room started · Round-robin · 3 participants' },
    { by: 'Opus', text: 'Cold start is 2.9 s on the reference laptop. I’d set the budget at 1.5 s and lazy-load the rooms engine, the charts and the Monaco editor.' },
    { by: 'Llama', text: 'A budget nobody measures in CI will drift back. Put the number in a test first.' },
    { by: 'GPT', tools: [{ name: 'read_file', ok: true, args: { path: 'web-app/dist/stats.json' }, output: '412 chunks' }], text: 'Monaco alone is 38% of the initial bundle. Moving it behind the editor route gets us to about 1.8 s.' },
    { sys: true, text: 'Paused by you.' },
  ],
  license: () => [
    { sys: true, text: 'Room started · Moderator chooses · 2 participants' },
    { by: 'Haiku', text: 'Upstream is Apache-2.0, so staying on Apache-2.0 keeps merges simple and covers the patent grant.' },
    { by: 'Qwen', text: 'Agreed. The bundled model weights keep their own licenses; list them in a NOTICE file.' },
    { sys: true, text: 'Stopped by you.' },
  ],
  naming: () => [],
}

const LIVE_TEXT =
  'I can add the counter as a feature flag in `AgentSettings`, off by default. It logs each repair with the original and fixed string, so we can audit false positives after release. @Gemini once the UNC tests land I’ll rerun the numbers.'

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
