/**
 * Development-only discussion rooms for the `?preview` seed (see
 * previewSeed.ts): the design mockup's four example rooms and their
 * transcripts, served through the rooms engine's persistence port so the real
 * store, bindings and pages render them. Writes stay in memory.
 */
import { noteIsolation } from '@/lib/rooms/isolation'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
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
    id: 'compare',
    title: 'Which model explains it best?',
    objective: 'Compare how each model explains a weather concept to a new user of the app.',
    status: 'awaiting-user',
    mode: 'compare',
    turns: 6,
    rounds: 2,
    tokens: 9_300,
    cost: 0.05,
    maxCost: null,
    activeMs: (1 * 60 + 25) * 1000,
    ageMin: 25,
    parts: [
      ['Sonnet', '', 'anthropic', 'claude-sonnet-5', 'none', 0],
      ['GPT', '', 'openai', 'gpt-5', 'none', 3],
      ['Qwen', '', 'llamacpp', 'qwen3-8b-instruct', 'none', 5],
      // Added after the questions were asked: shows the unanswered cells.
      ['Qwen 3.5', '', 'llamacpp', 'qwen3.5-9b-instruct', 'none', 2],
    ],
  },
  {
    id: 'compare-code',
    title: 'Fix the flaky retry test',
    objective: 'Each model fixes the flaky radar retry test in its own copy of the repo.',
    status: 'awaiting-user',
    mode: 'compare',
    turns: 2,
    rounds: 1,
    tokens: 14_200,
    cost: 0.08,
    maxCost: null,
    activeMs: 95 * 1000,
    ageMin: 12,
    folder: 'C:\\Projects\\weather-app',
    parts: [
      ['Sonnet', '', 'anthropic', 'claude-sonnet-5', 'edit', 0],
      ['Qwen', '', 'llamacpp', 'qwen3-8b-instruct', 'full', 5],
    ],
  },
  // Rich text in a compare room: markdown, code, a table, a tool call written
  // as text, and a turn that ran out of tokens thinking. Only with
  // `?preview&roomsRich`, so the default preview stays as the screenshots show it.
  {
    id: 'rich-text',
    title: 'Add mul to app.js',
    objective: 'Each model adds a mul function to src/app.js.',
    status: 'awaiting-user',
    mode: 'compare',
    turns: 3,
    rounds: 1,
    tokens: 6_100,
    cost: null,
    maxCost: null,
    activeMs: 40 * 1000,
    ageMin: 5,
    folder: 'C:\\Projects\\calc',
    parts: [
      ['Alice', '', 'llamacpp', 'qwen3-8b', 'edit', 4],
      ['Bob', '', 'llamacpp', 'qwen3-8b', 'edit', 6],
      ['Carol', '', 'llamacpp', 'qwen3-8b', 'edit', 1],
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
    ...(s.mode === 'compare' ? { compareRun: 'one-by-one' as const } : {}),
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
    // A compare room waiting for the user has heard everyone this round.
    spokenThisRound: (s.mode === 'compare' ? parts : parts.slice(0, 1)).map((p) => p.id),
    nextSpeakerId: s.mode === 'compare' ? null : (parts[1]?.id ?? null),
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
  /** The round, when the spread over `usage.rounds` would put it wrong. */
  round?: number
  usage?: RoomMessage['usage']
  changes?: RoomMessage['changes']
  budgetHit?: RoomMessage['budgetHit']
  finishReason?: string
  reasoning?: string
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
        round: m.round ?? Math.max(1, Math.ceil(((i + 1) / list.length) * room.usage.rounds)),
        createdAt: start + i * 2 * MIN,
        status: 'complete',
        ...(m.tools ? { toolCalls: m.tools } : {}),
        ...(m.usage ? { usage: m.usage } : {}),
        ...(m.changes ? { changes: m.changes } : {}),
        ...(m.budgetHit ? { budgetHit: m.budgetHit } : {}),
        ...(m.finishReason ? { finishReason: m.finishReason } : {}),
        ...(m.reasoning ? { reasoning: m.reasoning } : {}),
        ...(room.mode === 'compare' && p && kind === 'speech'
          ? { compare: { provider: p.model.provider, model: p.model.id, durationMs: 1800 + i * 210 } }
          : {}),
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
  compare: () => [
    { sys: true, text: 'Room started · Compare models · 3 participants' },
    { you: true, round: 1, text: 'In one short paragraph: what does "feels like" temperature mean?' },
    {
      by: 'Sonnet',
      round: 1,
      usage: { inputTokens: 410, outputTokens: 96, estimated: false, tokensPerSecond: 71 },
      text: '“Feels like” is how warm or cold the air seems on your skin, not what the thermometer reads. Wind pulls heat away from you, so a windy 5 °C can feel like 1 °C; humidity stops sweat from cooling you, so a muggy 30 °C can feel like 35 °C.',
    },
    {
      by: 'GPT',
      round: 1,
      usage: { inputTokens: 402, outputTokens: 74, estimated: false, tokensPerSecond: 88 },
      text: 'It is the temperature your body perceives once wind chill (in the cold) or the heat index (in the heat) is taken into account. Dress for the “feels like” number, not the actual one.',
    },
    {
      by: 'Qwen',
      round: 1,
      usage: { inputTokens: 398, outputTokens: 112, estimated: true, tokensPerSecond: 34 },
      text: 'The apparent temperature combines air temperature with wind speed and relative humidity to estimate the thermal sensation on exposed skin. Below about 10 °C wind lowers it; above about 27 °C humidity raises it.',
    },
    { you: true, round: 2, text: 'Now say it so a ten-year-old gets it.' },
    {
      by: 'Sonnet',
      round: 2,
      usage: { inputTokens: 640, outputTokens: 58, estimated: false, tokensPerSecond: 69 },
      text: 'Wind blows your warmth away, so it feels colder than it is. Sticky, wet air keeps you from cooling down, so it feels hotter.',
    },
    {
      by: 'GPT',
      round: 2,
      usage: { inputTokens: 588, outputTokens: 41, estimated: false, tokensPerSecond: 90 },
      text: 'It’s how cold or hot it feels to you, not to the thermometer. Wind makes it feel colder; muggy air makes it feel hotter.',
    },
    {
      by: 'Qwen',
      round: 2,
      usage: { inputTokens: 671, outputTokens: 63, estimated: true, tokensPerSecond: 31 },
      text: 'Think of a fan on a cool day: brr! That’s wind making it feel colder. On a sticky summer day you feel extra hot because your sweat can’t dry.',
    },
  ],
  'compare-code': () => [
    { sys: true, text: 'Room started · Compare models · 2 participants' },
    { you: true, round: 1, text: 'The radar retry test fails about one run in ten. Find out why and fix it.' },
    {
      by: 'Sonnet',
      round: 1,
      tools: [
        { name: 'read', ok: true, args: { path: 'src/radar/retry.test.ts' }, ms: 40 },
        { name: 'edit', ok: true, args: { path: 'src/radar/retry.test.ts' }, ms: 120 },
      ],
      changes: {
        workspace: 'C:\\Users\\me\\AppData\\Roaming\\Flint\\rooms\\compare-code\\workspaces\\sonnet',
        files: [
          {
            path: 'src/radar/retry.test.ts',
            additions: 4,
            deletions: 2,
            excerpt:
              '@@ -18,8 +18,10 @@\n-  await sleep(100)\n-  expect(calls).toBe(3)\n+  vi.useFakeTimers()\n+  const done = retry(fetchFrame)\n+  await vi.runAllTimersAsync()\n+  expect(await done).toBe(frame)',
          },
          { path: 'src/radar/retry.ts', additions: 1, deletions: 0, excerpt: '+export const RETRY_JITTER_MS = 50' },
        ],
      },
      text: 'The test slept a fixed 100 ms while the retry waits up to 120 ms with jitter, so it raced. I switched it to fake timers; it no longer depends on the clock.',
    },
    {
      by: 'Qwen',
      round: 1,
      tools: [{ name: 'bash', ok: true, args: { command: 'npx vitest run src/radar' }, ms: 4100 }],
      budgetHit: 'tool-calls',
      text: 'I ran the radar tests several times to reproduce the failure but used up my tool calls before changing anything.',
    },
  ],
  'rich-text': () => [
    { sys: true, text: 'Room started · Compare models · 3 participants' },
    { you: true, round: 1, text: 'Edit `src/app.js`: add a function **mul(a, b)** that returns `a*b` and export it.' },
    {
      by: 'Alice',
      round: 1,
      tools: [
        { name: 'read', ok: true, args: { path: 'C:\\Projects\\calc\\src\\app.js' }, output: 'function add(a, b) { return a + b }\nmodule.exports = { add }\n', ms: 30 },
        { name: 'read', ok: false, args: { path: 'C:\\Projects\\calc\\src\\app.js', offset: 5 }, output: 'ERROR: offset 5 is beyond end of file (2 lines total)', ms: 12 },
      ],
      text:
        '## Change\n\nAdded `mul` next to `add`:\n\n```js\nfunction add(a, b) { return a + b }\nfunction mul(a, b) { return a * b }\nmodule.exports = { add, mul } // a long line so the block has to scroll sideways inside its own column rather than widen it\n```\n\n| function | before | after |\n|---|---|---|\n| add | yes | yes |\n| mul | no | **yes** |\n\n- exported from `module.exports`\n- no other file touched\n\nSee [Node modules](https://nodejs.org/api/modules.html).',
    },
    {
      by: 'Bob',
      round: 1,
      tools: [{ name: 'read', ok: true, args: { path: 'C:\\Projects\\calc\\src\\app.js' }, output: 'function add(a, b) { return a + b }\n', ms: 25 }],
      text:
        '<tool_call>\n' +
        JSON.stringify({
          name: 'edit',
          arguments: {
            path: 'C:\\Projects\\calc\\src\\app.js',
            content: 'function add(a, b) { return a + b }\nfunction mul(a, b) { return a * b }\nmodule.exports = { add, mul }',
          },
        }) +
        '\n</tool_call>',
    },
    {
      by: 'Carol',
      round: 1,
      finishReason: 'length',
      usage: { inputTokens: 2614, outputTokens: 1024, estimated: false, tokensPerSecond: 113 },
      reasoning: 'Okay, the user wants mul added. First I should read the file. Wait, maybe the file uses ES modules? Let me think about both cases...',
      text: '',
    },
  ],
  naming: () => [],
}

const LIVE_TEXT =
  'I can add the metric as a flag in `config.Radar`, off by default. It counts each fallback with the age of the cached frame, so we can see how stale the map gets. @Gemini once the timeout test lands I’ll rerun the numbers.'

export function seedRooms() {
  const rooms = new Map<string, Room>()
  const journals = new Map<string, RoomJournalRecord[]>()
  const rich = new URLSearchParams(window.location.search).has('roomsRich')
  for (const s of SPECS) {
    if (s.id === 'rich-text' && !rich) continue
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

  // The coding compare room: isolation could not be made (shown in the
  // editor), and a prompt from before the pause is held on screen.
  noteIsolation('compare-code', 'the folder is not trusted')
  const qwen = rooms.get('compare-code')?.participants.find((p) => p.name === 'Qwen')
  if (qwen && !useToolApprovalRequests.getState().pending['preview-held-1']) {
    const ctrl = new AbortController()
    void useToolApprovalRequests.getState().requestApproval('preview-held-1', 'bash', 'compare-code', undefined, {
      input: { command: 'npm install --save-dev vitest-retry' },
      origin: qwen.name,
      workspaceLabel: 'C:\\Projects\\weather-app',
      signal: ctrl.signal,
      holdOnAbort: () => 'room paused',
    })
    ctrl.abort()
  }

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
