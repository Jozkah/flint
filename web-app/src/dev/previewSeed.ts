/**
 * Development-only preview data for looking at the interface in a plain
 * browser (`yarn dev:web`, then open any page with `?preview`). Outside Tauri
 * there are no providers, chats or sessions, and the first-run setup screen
 * covers the chat pages; this fills the stores with the same example content
 * the design mockup used, so pages can be compared screen for screen. All of
 * it is invented: an example "acme-weather" project, people and pull requests.
 *
 * Never imported in production builds (see main.tsx), and it writes to the
 * in-memory stores only.
 */
import type { ThreadMessage } from '@janhq/core'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { useMessages } from '@/hooks/useMessages'
import { useAppState } from '@/hooks/useAppState'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import { useCoworkView } from '@/hooks/useCoworkView'
import { useUsageStats, dayKey } from '@/stores/usage-stats-store'
import { useServiceStore } from '@/hooks/useServiceHub'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { buildScopeChoice, type ApprovalScopeWire } from '@/lib/approvalScopes'
import { useAssistant } from '@/hooks/useAssistant'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import { usePrStatusStore } from '@/stores/pr-status-store'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useCoworkOrigins } from '@/hooks/useCoworkOrigins'
import { useSplitConversation } from '@/hooks/useSplitConversation'
import { useConversationGroups } from '@/lib/groups/store'
import { projectKeyOf } from '@/lib/coworkCode'
import { buildExcerpt, joinMentionBlocks, mentionToken } from '@/lib/chatMentions'
import { setRoomPersistence, type RoomPersistence } from '@/lib/rooms/persistence'
import { useRoomsStore } from '@/lib/rooms/store'
import { answer } from './previewTauri'
import { seedStudioAnswers } from './previewStudio'
import { seedRooms } from './previewRooms'
import { seedApplyReviewPreview } from './previewApplyReview'
import { seedBrowserPane } from './previewBrowser'
import { seedEngine } from './previewSeedEngine'
import { seedHuggingFacePreview } from './previewHuggingFace'
import { seedRichSearch } from './previewRichSearch'
import {
  nestedPreviewSessions,
  nestedPreviewThreads,
  seedNestingState,
} from './previewNesting'
import {
  PREVIEW_DATA_FOLDER,
  patchSettingsServices,
  seedSettingsPreview,
} from './previewSeedSettings'

const MIN = 60_000
const now = Date.now()

const model = (id: string, name: string, caps: string[] = ['tools']) =>
  ({ id, name, displayName: name, capabilities: caps, settings: {} }) as unknown as Model

function providers(): ModelProvider[] {
  return [
    {
      provider: 'llamacpp',
      active: true,
      api_key: '',
      base_url: '',
      settings: [],
      models: [
        model('qwen3-8b-instruct', 'Qwen3 8B Instruct', ['tools', 'reasoning']),
        model('gemma-3-12b-it-Q5_K_M', 'Gemma 3 12B', ['tools', 'vision']),
        model('llama-3.1-8b', 'Llama 3.1 8B', ['tools', 'vision']),
        model('Mistral-Small-3.2-24B-Q4_K_S', 'Mistral Small 3.2', ['tools']),
        model('phi-4-mini-Q8_0', 'Phi-4 mini', ['tools']),
        model('Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-IQ4_XS', 'Qwen3.6-27B-IQ4_XS-LORA-Davidau-Fable', ['tools']),
        model('Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-Q4_K_M', 'Qwen3.6-27B-Q4_K_M-Davidau-Fable', ['tools']),
        model('Qwen3.8-27B-TTURBO-Fable-C-Fusion-709-IQ4_NL', 'Qwen3.8-27b-IQ4_NL-Davidau', ['tools']),
        model('LFM2.5-2.6B-Q3.8-TBrilliance-NEO-MAX-Q3_K_M', 'LFM2.5-2.6B', ['tools']),
        model('LFM2.5-2.6B-Q3.8-TBrilliance-BF16', 'LFM2.5-2.6B', ['tools']),
        model('Cydonia-24B-v4.3-absolute-heresy.i1-Q4_1', 'Cydonia-24B-Q4_1-v4.3-Absolute-Heresy', ['tools']),
      ],
    },
    {
      provider: 'anthropic',
      active: true,
      api_key: 'sk-preview',
      base_url: 'https://api.anthropic.com/v1',
      settings: [],
      models: [
        model('claude-sonnet-5', 'Claude Sonnet 5', ['tools', 'vision', 'reasoning']),
        model('claude-opus-5-5', 'Claude Opus 5.5', ['tools', 'vision', 'reasoning']),
        model('claude-haiku-4-5', 'Claude Haiku 4.5', ['tools', 'vision']),
      ],
    },
    {
      provider: 'openai',
      active: true,
      api_key: 'sk-preview',
      base_url: 'https://api.openai.com/v1',
      settings: [],
      models: [
        model('gpt-5', 'GPT-5', ['tools', 'vision', 'reasoning']),
        model('gpt-5-mini', 'GPT-5 mini', ['tools', 'vision']),
      ],
    },
    {
      provider: 'gemini',
      active: true,
      api_key: 'sk-preview',
      base_url: '',
      settings: [],
      models: [model('gemini-3-pro', 'Gemini 3 Pro', ['tools', 'vision', 'reasoning'])],
    },
    {
      provider: 'openrouter',
      active: true,
      api_key: 'sk-preview',
      base_url: 'https://openrouter.ai/api/v1',
      settings: [],
      models: [
        model('deepseek/deepseek-v3.2', 'DeepSeek V3.2', ['tools', 'reasoning']),
        model('x-ai/grok-4', 'Grok 4', ['tools', 'vision']),
      ],
    },
  ] as unknown as ModelProvider[]
}

// Everything below is invented example content for screenshots: a made-up
// "acme-weather" project (a Go API with a TypeScript dashboard), made-up
// people and made-up pull requests. None of it comes from a real data folder.
const FOLDERS = [
  { id: 'weather', name: 'acme-weather', updated_at: now, assistantId: 'jan' },
  { id: 'docs', name: 'Docs site', updated_at: now - 60 * MIN },
  { id: 'home', name: 'Home lab', updated_at: now - 300 * MIN },
]

/**
 * The built-in and starter assistants the desktop assistant extension seeds
 * (extensions/assistant-extension), kept to the fields the screens show so the
 * preview has their icons. Keep in step with builtInAssistants.ts.
 */
export const PREVIEW_BUILT_IN_ASSISTANTS = [
  { id: 'quartz', name: 'Quartz', avatar: '/images/assistants/quartz.png', description: 'A precise research and analysis specialist for evidence, comparisons, calculations, and decision-ready conclusions.' },
  { id: 'coal', name: 'Coal', avatar: '/images/assistants/coal.png', description: 'A hands-on software engineer for debugging, implementation, refactors, tests, and practical code review.' },
  { id: 'blaze', name: 'Blaze', avatar: '/images/assistants/blaze.png', description: 'A creative product and writing specialist for bold concepts, naming, UX ideas, copy, and polished creative output.' },
  { id: 'redstone', name: 'Redstone', avatar: '/images/assistants/redstone.png', description: 'A systems and automation specialist for repeatable workflows, integrations, operations, and reliable multi-step execution.' },
  { id: 'book-and-quill', name: 'Book and Quill', avatar: '/images/assistants/book-and-quill.png', description: 'A storyteller that writes and continues stories with vivid scenes and consistent characters.' },
  { id: 'compass', name: 'Compass', avatar: '/images/assistants/compass.png', description: 'A translator that converts text between languages faithfully and flags tricky wording.' },
  { id: 'emerald', name: 'Emerald', avatar: '/images/assistants/emerald.png', description: 'A money helper for budgeting, concepts and tradeoffs. Educational, not licensed financial advice.' },
  { id: 'book', name: 'Book', avatar: '/images/assistants/book.png', description: 'A study tutor that teaches step by step and checks understanding with short questions.' },
] as const

/** The example assistants: Flint, the built-ins, and two the user made. */
function assistants(): Assistant[] {
  const flint = useAssistant.getState().assistants.find((a) => a.id === 'jan')
  const base = { created_at: now / 1000, description: '', instructions: '', parameters: {} }
  return [
    ...(flint ? [flint] : []),
    ...PREVIEW_BUILT_IN_ASSISTANTS.map((a) => ({ ...base, ...a })),
    { ...base, id: 'go-reviewer', name: 'Go reviewer', avatar: '🐹' },
    { ...base, id: 'changelog', name: 'Changelog writer', avatar: '✍️', description: 'Turns commit lists into short release notes.' },
  ] as unknown as Assistant[]
}

/** MCP tools, grouped by server as the tools drawer lists them. */
function mcpTools() {
  const tool = (server: string, name: string, description: string) => ({
    server,
    name,
    description,
    inputSchema: {},
  })
  return [
    tool('filesystem', 'read_file', 'Read a file'),
    tool('filesystem', 'write_file', 'Write a file'),
    tool('filesystem', 'list_directory', 'List a folder'),
    tool('filesystem', 'search_files', 'Search file names'),
    tool('github', 'get_issue', 'Read an issue'),
    tool('github', 'create_issue', 'Open an issue'),
    tool('github', 'list_pull_requests', 'List pull requests'),
    tool('github', 'get_pull_request', 'Read a pull request'),
    tool('github', 'create_pull_request', 'Open a pull request'),
    tool('github', 'search_code', 'Search code'),
    tool('playwright', 'browser_navigate', 'Open a page'),
    tool('playwright', 'browser_click', 'Click an element'),
  ]
}

type ChatSeed = [id: string, title: string, ageMin: number, folder?: string, pinned?: boolean]
const CHATS: ChatSeed[] = [
  ['release', 'Forecast cache returns stale data', 2, 'weather', true],
  ['kravio', 'Dashboard color palette', 20, undefined, true],
  ['escape', 'Retry policy for the radar feed', 90, 'weather'],
  ['pr418', 'acme/weather | issue #9 | PR #12', 240, 'weather'],
  ['toolargs', 'Unit conversion edge cases', 30, 'weather'],
  ['sandbox', 'Flaky integration tests on CI', 1500, 'weather'],
  ['draft', 'Hourly chart tooltip design', 2900, 'weather'],
  ['notes', 'API reference outline', 600, 'docs'],
  ['offsets', 'Getting started page draft', 4000, 'docs'],
  ['provider', 'Raspberry Pi sensor setup', 45, 'home'],
  ['trip', 'Weekend hiking ideas', 6000],
  ['cmdwin', 'Explain Go generics', 8000],
  ['vllm', 'Sourdough starter schedule', 9000],
  ['clutter', 'SQL window functions', 12000],
  ['test', 'Regex for ISO dates', 20000],
  ['mdshow', 'Markdown showcase', 25000],
  // Same title in three places, and one very long title: the @ / # menus tell
  // the first apart and truncate the second.
  ['plan1', 'Weekly planning', 300, 'weather'],
  ['plan2', 'Weekly planning', 800, 'docs'],
  ['plan3', 'Weekly planning', 5000],
  ['longtitle', 'Investigate why the nightly benchmark regression only reproduces on the Windows runner after the allocator upgrade and compare it with the Linux numbers', 120, 'weather'],
]

/** Every markdown feature the renderer styles: lists, tasks, tables, mermaid, long code. */
const MARKDOWN_SHOWCASE = [
  '# Markdown showcase',
  '',
  'Some **bold**, *italic*, ~~strike~~ and `inline code` with a [link](https://example.com).',
  '',
  '## Lists',
  '1. First ordered item that is long enough to wrap onto a second line so that hanging indent can be inspected properly in the UI',
  '2. Second item',
  '   - nested bullet one',
  '   - nested bullet two with more words to wrap around the container width and show the indentation',
  '     - third level bullet',
  '',
  '- A top-level bullet that is long enough to wrap onto a second line so the hanging indent shows',
  '- Second bullet',
  '',
  '- [x] done task',
  '- [ ] open task',
  '',
  '## Table',
  '| Name | Role | Team | Location |',
  '|---|---|---|---|',
  '| Alice | Engineer | Platform | Amsterdam |',
  '| Charlie | Designer | Growth | Barcelona |',
  '| Dana | Manager | Infrastructure | Copenhagen |',
  '',
  '## Diagram',
  '```mermaid',
  'graph TD',
  '  A[Start] --> B{Check}',
  '  B -->|yes| C[Ship]',
  '  B -->|no| D[Fix]',
  '  D --> B',
  '```',
  '',
  '## Long code',
  '```ts',
  ...Array.from({ length: 72 }, (_, i) => `const line${i} = ${i} // code line ${i} that is fairly long to test wrapping`),
  '```',
].join('\n')

/** A short exchange for a seeded chat, so its row can show a count and a preview. */
function fillerMessages(id: string, title: string): ThreadMessage[] {
  const base = { object: 'thread.message', thread_id: id, status: 'ready' }
  const lines: [string, string][] = id === 'mdshow'
    ? [['user', 'Show every markdown feature.'], ['assistant', MARKDOWN_SHOWCASE]]
    : [
    ['user', `Let's work on: ${title}`],
    ['assistant', 'Sure. Start with the smallest change that shows the problem, then widen it.'],
    ['user', 'Agreed. I will try that tomorrow and report back with the numbers.'],
    ['assistant', 'Good plan. Keep the before and after side by side so the difference is easy to see.'],
  ]
  // plan1 opens with a mention of another chat, as the composer sends it, so
  // the transcript shows the "Mentioned" chips.
  if (id === 'plan1') {
    const mentioned = buildExcerpt({
      kind: 'chat',
      id: 'release',
      title: 'Forecast cache returns stale data',
      project: 'acme-weather',
      messages: [
        { role: 'user', text: 'The /v1/forecast endpoint keeps returning yesterday’s data after midnight UTC.' },
        { role: 'assistant', text: 'The cache key ignores the date, so it never expires at midnight.' },
      ],
    }).block
    const session = buildExcerpt({
      kind: 'session',
      id: 'dash',
      title: 'Hourly chart tooltip',
      project: 'acme-weather',
      messages: [{ role: 'user', text: 'Show the feels-like temperature in the tooltip.' }],
    }).block
    lines[0][1] = joinMentionBlocks(
      `What did we decide in @${mentionToken('chat', 'release', 'Forecast cache returns stale data')} and @${mentionToken('session', 'dash', 'Hourly chart tooltip')}? Let's plan around it.`,
      [mentioned, session]
    )
  }
  return lines.map(
    ([role, line], i) =>
      ({
        ...base,
        id: `${id}-m${i}`,
        role,
        created_at: now - (60 - i) * MIN,
        completed_at: now - (60 - i) * MIN,
        content: [{ type: 'text', text: { value: line, annotations: [] } }],
      }) as unknown as ThreadMessage
  )
}

function threads(): Thread[] {
  const base = {
    assistants: useAssistant.getState().assistants.filter((a) => a.id === 'jan'),
    model: { id: 'claude-sonnet-5', provider: 'anthropic' },
  } as Partial<Thread>
  return [...chatThreads(), ...nestedPreviewThreads(now, base)]
}

function chatThreads(): Thread[] {
  return CHATS.map(([id, title, age, folder, pinned]) => {
    const f = FOLDERS.find((x) => x.id === folder)
    return {
      id,
      title,
      updated: (now - age * MIN) / 1000,
      isFavorite: !!pinned,
      assistants: useAssistant.getState().assistants.filter((a) => a.id === 'jan'),
      model: { id: 'claude-sonnet-5', provider: 'anthropic' },
      metadata: f ? { project: { id: f.id, name: f.name, updated_at: f.updated_at } } : {},
    } as unknown as Thread
  })
}

const text = (value: string) => ({ type: 'text', text: { value, annotations: [] } })
const tool = (name: string, id: string, input: object, output: string) => ({
  type: 'tool_call',
  tool_name: name,
  tool_call_id: id,
  input,
  output,
})

const ESC = '\u001b['
const g = (s: string) => `${ESC}1;32m${s}${ESC}0m`
const r = (s: string) => `${ESC}1;31m${s}${ESC}0m`
const y = (s: string) => `${ESC}33m${s}${ESC}0m`

// `?preview&attachments`: the first message carries a 200k-line paste and a
// 5 MB log as inline files, to exercise the full attachment viewer.
const SEED_ATTACHMENTS =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('attachments')

function attachedBlock(): string {
  return [
    '',
    '',
    '[ATTACHED_FILES]',
    '- file_id: pasted-text-1.txt, name: pasted-text-1.txt, type: txt, size: 7088890, mode: inline',
    '- file_id: server.log, name: server.log, type: log, size: 5242880, mode: inline',
    '[/ATTACHED_FILES]',
  ].join('\n')
}

function bigAttachments(): Array<{ name: string; content: string }> {
  const paste = Array.from({ length: 200_000 }, (_, i) => `${i + 1}. forecast row ${i} temp=${(i % 40) - 5}C`).join('\n')
  const line = '2026-10-17T00:00:01Z INFO forecast cache refreshed region=eu-west hits=1204 misses=12\n'
  const log = 'x'.repeat(6000) + ' (one very long line)\n' + line.repeat(Math.ceil((5 * 1024 * 1024) / line.length))
  return [
    { name: 'pasted-text-1.txt', content: paste },
    { name: 'server.log', content: log },
  ]
}

/** A short chat with tool calls whose arguments are long, nested or empty. */
function toolArgsMessages(id: string): ThreadMessage[] {
  const base = { object: 'thread.message', thread_id: id, status: 'ready' }
  const t = (m: number) => now - m * MIN
  const done = { created_at: t(30), completed_at: t(30) }
  if (id === 'escape') {
    return [
      { ...base, id: `${id}-m1`, role: 'user', ...done, content: [text('The radar feed times out a few times a day and the map goes blank. Add a bounded retry with a cached fallback.')] },
      {
        ...base,
        id: `${id}-m2`,
        role: 'assistant',
        ...done,
        content: [
          tool('read', 'e1', { path: 'internal/radar/client.go' }, '118 lines · func (c *Client) Fetch(ctx context.Context, region string) (*Frame, error)'),
          tool('bash', 'e2', { command: 'go test ./internal/radar/ -run TestFetchTimeout' }, `--- ${r('FAIL')}: TestFetchTimeout (2.00s)
    client_test.go:88: got error "context deadline exceeded", want cached frame
${r('FAIL')}`),
          text('The client gives up on the first timeout. I will retry up to three times with jitter and serve the last cached frame when every attempt fails, then add a test for it.'),
        ],
      },
    ] as unknown as ThreadMessage[]
  }
  return [
    { ...base, id: `${id}-m1`, role: 'user', ...done, content: [text('Convert units in the API and cover the odd cases: empty input, nested lists, very long keys.')] },
    {
      ...base,
      id: `${id}-m2`,
      role: 'assistant',
      ...done,
      content: [
        tool('write', 'u1', { path: 'internal/units/convert.go', content: '' }, 'Wrote 0 bytes'),
        tool('edit_file', 'u2', { path: 'internal/units/convert_test.go', edits: [{ find: 'func TestConvert(t *testing.T) {', replace: 'func TestConvertTable(t *testing.T) {' }, { find: 'want := 1.0', replace: 'want := 1.0 // metres' }] }, 'Edited internal/units/convert_test.go (+2 -2)'),
        tool('web_search', 'u3', { query: 'celsius to fahrenheit conversion rounding half away from zero versus banker rounding in go math package', filters: { site: ['pkg.go.dev', 'go.dev', 'stackoverflow.com'], freshness: 'year', language: 'en' }, top: 6 }, JSON.stringify([{ title: 'math package - Go documentation', url: 'https://pkg.go.dev/math' }])),
        tool('bash', 'u4', { command: 'go test ./internal/units/... -run "TestConvert(Table|Empty|Nested)" -count=1 -v -race -timeout 60s -coverprofile=cover.out', cwd: '~/projects/acme-weather' }, 'ok  	github.com/acme/weather/internal/units	0.512s	coverage: 94.1% of statements'),
        text('Empty input returns an empty result, nested lists convert element by element, and keys longer than 64 bytes are rejected with a clear error. Tests cover all three.'),
      ],
    },
  ] as unknown as ThreadMessage[]
}

function releaseMessages(): ThreadMessage[] {
  const base = { object: 'thread.message', thread_id: 'release', status: 'ready' }
  const t = (m: number) => now - m * MIN
  return [
    {
      ...base,
      id: 'm1',
      role: 'user',
      created_at: t(3),
      completed_at: t(3),
      content: [text('The /v1/forecast endpoint keeps returning yesterday’s data after midnight UTC. Can you find out why and fix it?' + (SEED_ATTACHMENTS ? attachedBlock() : ''))],
      ...(SEED_ATTACHMENTS ? { metadata: { inline_file_contents: bigAttachments() } } : {}),
    },
    {
      ...base,
      id: 'm2',
      role: 'assistant',
      created_at: t(2),
      completed_at: t(2),
      metadata: {
        tokenSpeed: { tokenSpeed: 42.3, tokenCount: 1284, durationMs: 30350 },
        model: { id: 'qwen3-8b-instruct', provider: 'llamacpp' },
        attribution: {
          v: 1,
          requestId: 'req-preview',
          snapshotId: null,
          snapshotHash: null,
          invocationId: null,
          snapshotStatus: 'not-captured',
          assembledAt: new Date(t(3)).toISOString(),
          memory: {
            injectedIds: ['mem-1', 'mem-2'],
            injectedHashes: [],
            conflictIds: [],
            droppedIds: [],
            candidateIds: ['mem-1', 'mem-2'],
            projectId: 'jan-project:weather',
            projectName: 'acme-weather',
            disabled: false,
            temporary: false,
            unavailable: false,
          },
          tools: ['bash', 'read_file', 'grep', 'web_search', 'edit_file'],
          attachments: { inline: [], availableViaSearch: [] },
          provider: 'llamacpp',
          model: 'qwen3-8b-instruct',
          sendState: 'response-started',
          usageReported: true,
        },
      },
      content: [
        { type: 'reasoning', text: { value: 'Stale data right after midnight sounds like a cache key built from the local date instead of UTC. I’ll look at how the key is made.', annotations: [] } },
        tool('read', 'c1', { path: 'internal/cache/forecast.go' }, '64 lines · func keyFor(city string, day time.Time) string'),
        tool('grep', 'c2', { pattern: 'keyFor\\(', path: 'internal' }, 'internal/cache/forecast.go:18:func keyFor(city string, day time.Time) string {\ninternal/cache/forecast.go:41:\tk := keyFor(city, time.Now())\ninternal/api/forecast.go:57:\tif v, ok := c.Get(keyFor(q.City, q.Day)); ok {\ninternal/cache/forecast_test.go:12:\tgot := keyFor("oslo", day)'),
        tool('web_search', 'c3', { query: 'go time.Now() Format date local vs UTC', top: 4 }, JSON.stringify([
          { title: 'time package - Go documentation', url: 'https://pkg.go.dev/time' },
          { title: 'Always store and compare times in UTC', url: 'https://example.com/blog/utc' },
        ])),
        tool('bash', 'c4', { command: 'go test ./internal/cache/...', cwd: '~/projects/acme-weather' },
          `--- ${r('FAIL')}: TestKeyForMidnightUTC (0.00s)\n    forecast_test.go:27: key = "oslo:2026-09-25", want "oslo:2026-09-26"\n${r('FAIL')}\n${r('FAIL')}\tgithub.com/acme/weather/internal/cache\t0.412s\n[exit 1]`),
        { type: 'reasoning', text: { value: 'Confirmed: the key uses the server’s local date. I’ll build it from UTC.', annotations: [] } },
        tool('edit', 'c5', {
          path: 'internal/cache/forecast.go',
          old_string: '\treturn city + ":" + day.Format("2006-01-02")',
          new_string: '\t// Keys are always UTC so every server agrees on "today".\n\treturn city + ":" + day.UTC().Format("2006-01-02")',
        }, 'Edited internal/cache/forecast.go (+2 −1)'),
        tool('bash', 'c6', { command: 'go test ./...', cwd: '~/projects/acme-weather' },
          `${g('ok')}  \tgithub.com/acme/weather/internal/api\t0.861s\n${g('ok')}  \tgithub.com/acme/weather/internal/cache\t0.398s\n${g('ok')}  \tgithub.com/acme/weather/internal/units\t0.127s\n[exit 0]`),
        tool('bash', 'c7', { command: 'git status --short && git diff --stat' },
          `${r(' M')} internal/cache/forecast.go\n${r('??')} internal/cache/midnight_test.go\n internal/cache/forecast.go | 3 ${g('++')}${r('-')}\n 1 file changed, ${g('2 insertions(+)')}, ${r('1 deletion(-)')}\n[exit 0]`),
        { type: 'tool_call', tool_name: 'bash', tool_call_id: 'c8', input: { command: 'git commit -am "fix(cache): key forecasts by UTC date"' } },
        text('Fixed. `keyFor` now formats the day in UTC, so a server in any time zone rolls over at the same moment, and `go test ./...` passes. I also added a test that pins the clock to 00:05 UTC.'),
      ],
    },
  ] as unknown as ThreadMessage[]
}

/** How long each example call took, and the one still waiting for an answer. */
function seedToolRuntime() {
  const secs: Record<string, number> = { c1: 0.1, c2: 0.3, c3: 1.8, c4: 4.2, c5: 0.2, c6: 6.9, c7: 0.4 }
  let at = now - 3 * MIN
  const timings: Record<string, { startedAt: number; endedAt: number }> = {}
  for (const [id, s] of Object.entries(secs)) {
    timings[id] = { startedAt: at, endedAt: at + s * 1000 }
    at += s * 1000 + 2000
  }
  useToolCallRuntime.setState({
    timings,
    diffs: {
      c5: [
        '    17 | // keyFor names the cache entry for a city and day.',
        '    18 | func keyFor(city string, day time.Time) string {',
        '-   19 | \treturn city + ":" + day.Format("2006-01-02")',
        '+   19 | \t// Keys are always UTC so every server agrees on "today".',
        '+   20 | \treturn city + ":" + day.UTC().Format("2006-01-02")',
        '    21 | }',
      ].join('\n'),
    },
  } as never)
  if (!useToolApprovalRequests.getState().pending.c8) {
    useToolApprovalRequests.setState((s) => ({
      pending: {
        ...s.pending,
        c8: {
          requestId: 'preview-c8',
          toolCallId: 'c8',
          toolName: 'bash',
          threadId: 'release',
          input: { command: 'git commit -am "fix(cache): key forecasts by UTC date"' },
          taskContext: 'Commit the cache fix and the new midnight test.',
          workspaceLabel: '~/projects/acme-weather',
          // The "Always" form the backend offers for a command: the prefixes.
          ...(() => {
            const options: ApprovalScopeWire[] = [
              { type: 'command_prefix', prefix: 'git' },
              { type: 'command_prefix', prefix: 'git commit' },
            ]
            const choice = buildScopeChoice(options, 'bash')
            return choice
              ? {
                  choice,
                  chosenId: choice.defaultId,
                  scopeForm: { root: '~/projects/acme-weather', options },
                }
              : {}
          })(),
          resolve: () => {},
        },
      },
    }))
  }
}

function seedUsage() {
  const days: Record<string, ReturnType<typeof useUsageStats.getState>['days'][string]> = {}
  const shape = [520, 610, 360, 480, 584, 470, 640, 600, 560, 620, 380, 690, 540, 500]
  shape.forEach((k, i) => {
    const tok = k * 1000 * 0.12
    days[dayKey(now - (shape.length - 1 - i) * 86_400_000)] = {
      tokens: Math.round(tok),
      genMs: Math.round((tok / 48.6) * 1000),
      timedTokens: Math.round(tok),
      replies: 30 + i,
      toolOk: 60 + i,
      toolFail: 2,
    }
  })
  const act = (m: number, kind: never, title: string, detail: string) => ({
    id: `p${m}`,
    kind,
    title,
    detail,
    at: now - m * MIN,
  })
  useUsageStats.setState({
    days,
    activity: [
      act(20, 'tool-approved' as never, 'Tool call approved', 'Ran go test ./... in acme-weather'),
      act(25, 'run-finished' as never, 'Assistant created', 'Go reviewer with 5 tools'),
      act(40, 'model-swapped' as never, 'Model swapped', 'Chat moved to Qwen3 8B Instruct'),
      act(55, 'warning' as never, 'VRAM pressure', '7.6 / 8 GB used during load'),
      act(70, 'knowledge' as never, 'Knowledge indexed', 'Added 186 files from acme-weather/web'),
      act(70, 'compaction' as never, 'Context compacted', 'Forecast cache chat went from 24.8k to 5.1k tokens'),
    ],
  })
}

const JAN = 'C:\\Projects\\acme-weather'

/** A write/edit diff in the agent's own format: `±  line | text`. */
const diffOf = (hunks: [number, string][]) =>
  hunks.map(([n, l]) => `${l[0]} ${String(n).padStart(4)} | ${l.slice(1)}`).join('\n')

/** Preview options read from the address bar: `?preview&session=dash&split=release`. */
const params = () => new URLSearchParams(window.location.search)

const RETRY_DIFF = [
  '@@ edit 1/1 @@',
  diffOf([
    [42, '-\tresp, err := c.http.Do(req)'],
    [43, '-\tif err != nil {'],
    [44, '-\t\treturn nil, err'],
    [45, '-\t}'],
    [42, '+\tvar resp *http.Response'],
    [43, '+\terr := retry.Do(ctx, retry.Policy{'],
    [44, '+\t\tAttempts: 3,'],
    [45, '+\t\tBase:     250 * time.Millisecond,'],
    [46, '+\t\tJitter:   true,'],
    [47, '+\t}, func() (err error) {'],
    [48, '+\t\tresp, err = c.http.Do(req)'],
    [49, '+\t\treturn err'],
    [50, '+\t})'],
    [51, '+\tif err != nil {'],
    [52, '+\t\treturn c.cache.Latest(ctx, region) // serve the last good frame'],
    [53, '+\t}'],
  ]),
].join('\n')

/** The running example session: tool activity, a diff and a pending approval. */
function escapeSession() {
  const at = (m: number) => now - m * MIN
  const turns = [
    {
      role: 'user',
      content: 'The radar feed times out a few times a day and the map goes blank. Retry it with backoff, fall back to the cached frame, and add a test for the timeout.',
      startedAt: at(8),
    },
    {
      role: 'assistant',
      content: '<think>A blank map means the client gives up on the first timeout. A bounded retry covers the flaky feed, and the last cached frame covers a longer outage.</think>I’ll read the radar client, reproduce the timeout in a test, then add a bounded retry with a cached fallback.',
      startedAt: at(8),
    },
    {
      role: 'tool',
      name: 'read',
      callId: 'e1',
      args: { path: 'internal/radar/client.go' },
      result: '118 lines',
      toolState: 'succeeded',
      status: 'done',
      startedAt: at(7.9),
      endedAt: at(7.9) + 100,
    },
    {
      role: 'tool',
      name: 'bash',
      callId: 'e2',
      args: { command: 'go test ./internal/radar/ -run TestFetchTimeout' },
      result: `--- ${r('FAIL')}: TestFetchTimeout (2.00s)\n    client_test.go:88: got error ${y('"context deadline exceeded"')}, want cached frame\n${r('FAIL')}\tgithub.com/acme/weather/internal/radar\t2.114s`,
      isError: true,
      exitCode: 1,
      toolState: 'failed',
      status: 'done',
      startedAt: at(7.5),
      endedAt: at(7.5) + 2_300,
    },
    {
      role: 'tool',
      name: 'edit',
      callId: 'e3',
      args: { path: 'internal/radar/client.go' },
      result: 'Edited internal/radar/client.go (+14 −4)',
      diff: RETRY_DIFF,
      toolState: 'succeeded',
      status: 'done',
      startedAt: at(6),
      endedAt: at(6) + 200,
    },
    {
      role: 'tool',
      name: 'write',
      callId: 'e4',
      args: { path: 'internal/radar/client_test.go' },
      result: 'Edited internal/radar/client_test.go (+21 −0)',
      diff: diffOf([
        [90, '+func TestFetchFallsBackToCache(t *testing.T) {'],
        [91, '+\tsrv := slowServer(3 * time.Second)'],
        [92, '+\tc := newTestClient(srv.URL, withCachedFrame("frame-0412"))'],
        [93, '+\tgot, err := c.Fetch(ctxWithTimeout(t, time.Second), "nordic")'],
        [94, '+\trequire.NoError(t, err)'],
        [95, '+\tassert.Equal(t, "frame-0412", got.ID)'],
        [96, '+}'],
      ]),
      toolState: 'succeeded',
      status: 'done',
      startedAt: at(5),
      endedAt: at(5) + 150,
    },
    {
      role: 'tool',
      name: 'bash',
      callId: 'e5',
      args: { command: 'go test ./internal/radar/...' },
      result: `${g('ok')}  \tgithub.com/acme/weather/internal/radar\t1.284s`,
      exitCode: 0,
      toolState: 'succeeded',
      status: 'done',
      startedAt: at(4),
      endedAt: at(4) + 3_100,
    },
    {
      role: 'tool',
      name: 'bash',
      callId: 'e6',
      args: { command: 'git push -u origin flint/radar-retry && gh pr create --fill' },
      toolState: 'awaiting-permission',
      status: 'running',
      startedAt: at(0.3),
    },
  ]
  const plan = {
    phases: [
      {
        name: 'Fix',
        tasks: [
          { content: 'Read the radar client', status: 'completed' as const },
          { content: 'Reproduce the timeout with a failing test', status: 'completed' as const },
          { content: 'Add retry with backoff and a cached fallback', status: 'completed' as const },
          { content: 'Open a pull request', status: 'in_progress' as const },
        ],
      },
    ],
  }
  return {
    id: 'escape',
    title: 'Retry the radar feed',
    folder: JAN,
    mode: 'ask',
    access: 'managed-worktree',
    turns,
    subagents: [],
    todos: plan,
    // The plan as this run left it, recorded under its prompt.
    todoSnapshots: [{ anchorId: 'escape-user-0', list: plan }],
    messages: [],
    updated: at(0.3),
    model: { provider: 'llamacpp', id: 'qwen3-8b-instruct' },
  }
}

/** A finished session: unit conversion, merged as PR #11. */
function unitsSession() {
  const at = (m: number) => now - m * MIN
  return {
    id: 'paths',
    title: 'Convert units in the API',
    folder: UNITS_TREE,
    mode: 'ask',
    access: 'managed-worktree',
    turns: [
      { role: 'user', content: 'Add ?units=imperial to /v1/forecast. Convert °C to °F and km/h to mph in one place, and test the rounding.', startedAt: at(52) },
      { role: 'assistant', content: 'I’ll add a units package, wire it into the forecast handler, then test the edge cases.', startedAt: at(51), usage: { completion_tokens: 9_800 } },
      {
        role: 'tool', name: 'write', callId: 'u1', args: { path: 'internal/units/convert.go' },
        result: 'Created internal/units/convert.go', toolState: 'succeeded', status: 'done', startedAt: at(50), endedAt: at(50) + 120,
      },
      {
        role: 'tool', name: 'edit', callId: 'u2', args: { path: 'internal/api/forecast.go' },
        result: 'Edited internal/api/forecast.go (+9 −2)', toolState: 'succeeded', status: 'done', startedAt: at(49), endedAt: at(49) + 90,
      },
      {
        role: 'tool', name: 'write', callId: 'u3', args: { path: 'internal/units/convert_test.go' },
        result: 'Created internal/units/convert_test.go', toolState: 'succeeded', status: 'done', startedAt: at(48), endedAt: at(48) + 80,
      },
      {
        role: 'tool', name: 'bash', callId: 'u4', args: { command: 'go test ./...' },
        result: `${g('ok')}  \tgithub.com/acme/weather/internal/api\t0.861s\n${g('ok')}  \tgithub.com/acme/weather/internal/units\t0.127s`,
        exitCode: 0, toolState: 'succeeded', status: 'done', startedAt: at(47), endedAt: at(47) + 4_200,
      },
      {
        role: 'tool', name: 'bash', callId: 'u5', args: { command: 'go vet ./...' },
        result: '', exitCode: 0, toolState: 'succeeded', status: 'done', startedAt: at(46), endedAt: at(46) + 1_900,
      },
      {
        role: 'assistant',
        content: 'Done. `?units=imperial` now converts temperature, wind and rain in `internal/units`, rounding to one decimal. `go test ./...` and `go vet ./...` pass, including new cases for −40° and 0 km/h.',
        startedAt: at(46),
        endedAt: at(45),
      },
    ],
    messages: [],
    updated: at(45),
    model: { provider: 'llamacpp', id: 'qwen3-8b-instruct' },
  }
}

/** A finished session with the Code panel open on an edited file. */
function dashSession() {
  const at = (m: number) => now - m * MIN
  return {
    id: 'dash',
    title: 'Hourly chart tooltip',
    folder: JAN,
    mode: 'ask',
    access: 'direct',
    turns: [
      { role: 'user', content: 'The hourly chart tooltip shows raw Kelvin. Format it in the user’s units and show the wind direction.', startedAt: at(30) },
      { role: 'assistant', content: 'I’ll read the chart, then format the tooltip with the shared unit helpers.', startedAt: at(30), usage: { completion_tokens: 4_100 } },
      {
        role: 'tool', name: 'read', callId: 'd1', args: { path: 'web/src/charts/HourlyChart.tsx' },
        result: '84 lines', toolState: 'succeeded', status: 'done', startedAt: at(29), endedAt: at(29) + 80,
      },
      {
        role: 'tool', name: 'edit', callId: 'd2', args: { path: 'web/src/charts/tooltip.ts' },
        result: 'Edited web/src/charts/tooltip.ts (+7 −2)', toolState: 'succeeded', status: 'done', startedAt: at(28), endedAt: at(28) + 90,
      },
      {
        role: 'tool', name: 'bash', callId: 'd3', args: { command: 'npm test -- tooltip' },
        result: `${g(' PASS ')} src/charts/tooltip.test.ts (4 tests)`, exitCode: 0, toolState: 'succeeded', status: 'done', startedAt: at(27), endedAt: at(27) + 2_600,
      },
      {
        role: 'assistant',
        content: 'The tooltip now formats temperature with `formatTemp` in the user’s units and adds a compass point for the wind. All 4 tooltip tests pass.',
        startedAt: at(27),
        endedAt: at(26),
      },
    ],
    messages: [],
    updated: at(26),
    model: { provider: 'llamacpp', id: 'llama-3.1-8b' },
    codePanel: {
      tabs: [
        { path: 'web/src/charts/tooltip.ts', origin: { kind: 'project', projectKey: projectKeyOf(JAN) } },
        { path: 'web/src/charts/HourlyChart.tsx', origin: { kind: 'project', projectKey: projectKeyOf(JAN) } },
      ],
      activeTabId: `project:${projectKeyOf(JAN)}:web/src/charts/tooltip.ts`,
      expandedDirs: ['web', 'web/src', 'web/src/charts'],
      wordWrap: false,
    },
  }
}

/**
 * A finished Review only session: its writes are in the session sandbox,
 * ready to apply. One mirrors the project's tooltip.ts with changes; one is a
 * write into the sandbox's own `.jan/` settings, which Changes must not list.
 */
const REVIEW_WS = `${PREVIEW_DATA_FOLDER}\\agent-workspace\\sessions\\review`
const reviewTooltip = () => TOOLTIP_NOW.replace(
  '  const temp = formatTemp(p.tempK, units)',
  '  const temp = formatTemp(p.tempK, units, { digits: 0 })\n  const feels = formatTemp(p.feelsK, units, { digits: 0 })'
).replace('  return `${time}  ${temp}  ${wind}`', '  return `${time}  ${temp} (feels ${feels})  ${wind}`')

function reviewSession() {
  const at = (m: number) => now - m * MIN
  const write = (callId: string, rel: string, diff: [number, string][], m: number) => ({
    role: 'tool', name: rel.endsWith('.ts') && rel.includes('tooltip') ? 'edit' : 'write', callId,
    args: { path: `${REVIEW_WS}\\${rel.replace(/\//g, '\\')}` },
    result: `Wrote ${rel}`, diff: `@@ edit 1/1 @@\n${diffOf(diff)}`,
    toolState: 'succeeded', status: 'done', startedAt: at(m), endedAt: at(m) + 120,
  })
  return {
    id: 'review',
    title: 'Feels-like temperature in the tooltip',
    folder: JAN,
    mode: 'ask',
    turns: [
      { role: 'user', content: 'Add the feels-like temperature to the hourly tooltip and document the unit rules.', startedAt: at(12) },
      { role: 'assistant', content: 'Review only: I’ll work on copies in the session sandbox.', startedAt: at(12) },
      write('r1', 'acme-weather/web/src/charts/tooltip.ts', [
        [9, '-  const temp = formatTemp(p.tempK, units)'],
        [9, '+  const temp = formatTemp(p.tempK, units, { digits: 0 })'],
        [10, '+  const feels = formatTemp(p.feelsK, units, { digits: 0 })'],
        [12, '-  return `${time}  ${temp}  ${wind}`'],
        [12, '+  return `${time}  ${temp} (feels ${feels})  ${wind}`'],
      ], 11),
      write('r2', 'web/src/format/wind.ts', [
        [1, "+export const compassPoints = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']"],
        [2, '+export const compassPoint = (deg: number) => compassPoints[Math.round(deg / 45) % 8]'],
      ], 10),
      write('r3', 'docs/units.md', [
        [1, '+# Units'],
        [2, '+Temperatures are stored in Kelvin and shown in the user’s units, rounded to whole degrees.'],
      ], 9),
      write('r4', '.jan/agent/agent.toml', [[1, '+approval = "ask"']], 9),
      { role: 'assistant', content: 'Done. Three files are ready in the sandbox; nothing in acme-weather was changed.', startedAt: at(8), endedAt: at(8) },
    ],
    messages: [],
    updated: at(8),
    model: { provider: 'llamacpp', id: 'qwen3-8b-instruct' },
    codePanel: {
      tabs: [{ path: 'web/src/charts/tooltip.ts', origin: { kind: 'project', projectKey: projectKeyOf(JAN) } }],
      activeTabId: `project:${projectKeyOf(JAN)}:web/src/charts/tooltip.ts`,
      expandedDirs: ['web', 'web/src', 'web/src/charts'],
      wordWrap: false,
    },
  }
}

// Managed worktrees, named after the repository so the pull-request bar and
// the sidebar read "acme-weather".
const RADAR_TREE = 'C:\\Projects\\.worktrees\\radar-retry\\acme-weather'
const UNITS_TREE = 'C:\\Projects\\.worktrees\\units-api\\acme-weather'

const pr = (
  number: number,
  title: string,
  state: 'open' | 'merged',
  head: string,
  additions: number,
  deletions: number,
  checks: { passed: number; failed: number; pending: number }
) => ({
  lookup: {
    kind: 'found' as const,
    pr: { number, title, url: `https://github.com/acme/weather/pull/${number}`, state, head, base: 'main', additions, deletions, checks },
  },
  at: Date.now(),
  loading: false,
})

/**
 * A pull request a session recorded from its own `gh` call, with (unless
 * `lookup` says otherwise) the live status the sidebar card lists it with.
 */
const sessionPr = (
  number: number,
  title: string,
  state: 'open' | 'draft' | 'merged' | 'closed',
  head: string,
  additions: number,
  deletions: number,
  checks: { passed: number; failed: number; pending: number },
  minutesAgo: number,
  lookup: 'found' | 'loading' | 'failed' = 'found'
) => {
  const url = `https://github.com/acme/weather/pull/${number}`
  const recorded = { url, number, repo: 'acme/weather', head, at: new Date(now - minutesAgo * MIN).toISOString() }
  const entry =
    lookup === 'found'
      ? { lookup: { kind: 'found' as const, pr: { number, title, url, state, head, base: 'main', additions, deletions, checks } }, at: Date.now(), loading: false }
      : lookup === 'loading'
        ? { lookup: null, at: 0, loading: true }
        : { lookup: { kind: 'failed' as const, message: 'gh: HTTP 502 from the GitHub API' }, at: Date.now(), loading: false }
  return { recorded, entry }
}

function seedPrs() {
  // The changelog session opened three; the review session seven (one still
  // being looked up, one whose status could not be read), so the sidebar card
  // shows a short list, a folded one, and both wait states.
  const bySession: Record<string, ReturnType<typeof sessionPr>[]> = {
    changelog: [
      sessionPr(14, 'Changelog for 1.4', 'open', 'flint/changelog-1.4', 61, 3, { passed: 2, failed: 1, pending: 0 }, 40),
      sessionPr(13, 'Document the units query parameter', 'draft', 'flint/docs-units', 22, 0, { passed: 0, failed: 0, pending: 2 }, 55),
      sessionPr(9, 'Link the API guide from the README', 'merged', 'flint/readme-guide', 4, 1, { passed: 3, failed: 0, pending: 0 }, 90),
    ],
    review: [
      sessionPr(21, 'Feels-like temperature in the hourly tooltip', 'open', 'flint/feels-like', 48, 6, { passed: 5, failed: 0, pending: 0 }, 5),
      sessionPr(20, 'Compass points for wind direction', 'open', 'flint/wind-compass', 17, 2, { passed: 4, failed: 0, pending: 1 }, 15, 'loading'),
      sessionPr(19, 'Round shown temperatures to whole degrees', 'draft', 'flint/round-temps', 9, 9, { passed: 0, failed: 0, pending: 0 }, 25),
      sessionPr(18, 'Units section in docs', 'merged', 'flint/docs-units-section', 31, 0, { passed: 3, failed: 0, pending: 0 }, 60),
      sessionPr(17, 'Drop the Kelvin fallback', 'closed', 'flint/no-kelvin', 2, 40, { passed: 1, failed: 2, pending: 0 }, 120),
      sessionPr(16, 'Tooltip edge clipping', 'merged', 'flint/tooltip-clip', 12, 7, { passed: 3, failed: 0, pending: 0 }, 180),
      sessionPr(15, 'Cache forecast by UTC date', 'open', 'flint/utc-cache', 26, 11, { passed: 0, failed: 0, pending: 0 }, 240, 'failed'),
    ],
  }
  // Recorded oldest first, as the store keeps them.
  for (const prs of Object.values(bySession)) prs.reverse()
  usePrStatusStore.setState({
    byFolder: {
      [RADAR_TREE]: pr(12, 'Retry the radar feed with backoff', 'open', 'flint/radar-retry', 35, 4, { passed: 3, failed: 0, pending: 1 }),
      [UNITS_TREE]: pr(11, 'Add imperial units to /v1/forecast', 'merged', 'flint/units-api', 128, 12, { passed: 4, failed: 0, pending: 0 }),
    },
    byUrl: Object.fromEntries(Object.values(bySession).flat().map((p) => [p.recorded.url, p.entry])),
    sessionPrs: Object.fromEntries(Object.entries(bySession).map(([id, prs]) => [id, prs.map((p) => p.recorded)])),
    sessionPrsBackfilled: true,
    claims: { [`${RADAR_TREE}#12`]: 'escape', [`${UNITS_TREE}#11`]: 'paths' },
    backfilled: true,
  } as never)
}

/** Sidebar groups with folders, on the Cowork and Rooms surfaces. */
function seedGroups() {
  const folder = (path: string) => ({
    path,
    canonicalPath: path.replace(/\\/g, '/').toLowerCase(),
    displayName: path.split('\\').pop() ?? path,
    available: true,
  })
  const group = (surface: string, id: string, name: string, position: number, folders: string[]) => ({
    id, surface, name, position, collapsed: false,
    folderBindings: folders.map(folder), createdAt: now - 86_400_000, updatedAt: now,
  })
  const members = (groupId: string, ids: string[]) =>
    Object.fromEntries(ids.map((itemId, position) => [itemId, { groupId, itemId, position }]))
  useConversationGroups.setState((s: { state: { surfaces: Record<string, unknown> }; loaded: Record<string, boolean> }) => ({
    state: {
      ...s.state,
      version: 1,
      surfaces: {
        ...s.state.surfaces,
        cowork: {
          groups: [
            group('cowork', 'g-api', 'Weather API', 0, [JAN]),
            group('cowork', 'g-web', 'Dashboard', 1, [`${JAN}\\web`]),
          ],
          memberships: { ...members('g-api', ['escape', 'paths', 'changelog']), ...members('g-web', ['dash', 'kravio']) },
          contexts: {},
        },
        rooms: {
          groups: [
            group('rooms', 'g-release', 'Release 1.4', 0, [JAN]),
            group('rooms', 'g-lab', 'Home lab', 1, ['C:\\Projects\\home-sensors']),
          ],
          memberships: { ...members('g-release', ['arch', 'changelog', 'startup']), ...members('g-lab', ['offsets']) },
          contexts: {},
        },
      },
    },
    loaded: { ...s.loaded, cowork: true, rooms: true },
  }) as never)
}

/** Messages typed while a reply was still streaming: one steers, one waits. */
function seedQueue() {
  const q = [
    { id: 'q1', text: 'Also cap the backoff at 2 seconds so the map never waits longer than that.', createdAt: now - 20_000, steer: true },
    { id: 'q2', text: 'Then update the README section on radar caching.', createdAt: now - 8_000 },
  ]
  useMessageQueue.setState((s: { queues: Record<string, unknown[]> }) => ({
    queues: { ...s.queues, escape: q },
  }) as never)
}

/** The finished units run's record of what it changed. */
function seedOrigins() {
  useCoworkOrigins.setState((s: { bySession: Record<string, unknown> }) => ({
    bySession: {
      ...s.bySession,
      paths: {
        context: {
          binding: { folder: JAN },
          access: 'managed-worktree',
          destination: 'managed',
          tree: UNITS_TREE,
          baseline: null,
        },
        entries: [],
        summary: {
          janWrites: [
            {
              destination: 'managed',
              paths: ['internal/units/convert.go', 'internal/units/convert_test.go', 'internal/api/forecast.go'],
            },
          ],
          janWritesOverExisting: [],
          preExisting: [],
          observed: [],
          unknown: [],
          baseline: 'clean',
          tree: UNITS_TREE,
        },
        at: now - 45 * MIN,
      },
    },
  }) as never)
}

/** What the Code panel reads: the folder listing, the file, HEAD and blame. */
const TOOLTIP_HEAD = [
  "import type { HourPoint } from '../api/types'",
  "import { formatTime } from '../format/time'",
  '',
  '/** The text shown when hovering an hour on the chart. */',
  'export function tooltipText(p: HourPoint): string {',
  '  const time = formatTime(p.at)',
  '  const temp = `${p.tempK} K`',
  '  const wind = `${p.windKmh} km/h`',
  '  return `${time}  ${temp}  ${wind}`',
  '}',
  '',
].join('\n')
const TOOLTIP_NOW = [
  "import type { HourPoint } from '../api/types'",
  "import { formatTime } from '../format/time'",
  "import { formatTemp, formatWind, compassPoint } from '../format/units'",
  "import type { Units } from '../settings/units'",
  '',
  '/** The text shown when hovering an hour on the chart. */',
  'export function tooltipText(p: HourPoint, units: Units): string {',
  '  const time = formatTime(p.at)',
  '  const temp = formatTemp(p.tempK, units)',
  '  const wind = `${formatWind(p.windKmh, units)} ${compassPoint(p.windDeg)}`',
  '  return `${time}  ${temp}  ${wind}`',
  '}',
  '',
].join('\n')

function blamePorcelain(): string {
  const commits: Record<number, [sha: string, author: string, ageDays: number, summary: string]> = {
    0: ['3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345', 'Mara Lindqvist', 41, 'feat(web): hourly chart'],
    1: ['8b1e4d2c9a7f60518293a4b5c6d7e8f901234567', 'Theo Okafor', 12, 'refactor(web): shared time formatting'],
  }
  const who = [0, 1, -1, -1, 0, 0, -1, 0, -1, -1, 0, 0]
  return TOOLTIP_NOW.split('\n')
    .slice(0, who.length)
    .map((line, i) => {
      const c = who[i]
      if (c < 0) {
        return `${'0'.repeat(40)} ${i + 1} ${i + 1} 1\nauthor Not Committed Yet\nauthor-time ${Math.round(now / 1000)}\nsummary Version of tooltip.ts from tooltip.ts\n\t${line}`
      }
      const [sha, author, age, summary] = commits[c]
      return `${sha} ${i + 1} ${i + 1} 1\nauthor ${author}\nauthor-time ${Math.round((now - age * 86_400_000) / 1000)}\nsummary ${summary}\n\t${line}`
    })
    .join('\n')
}

const TREE: Record<string, [name: string, isDir: boolean][]> = {
  '': [['cmd', true], ['internal', true], ['web', true], ['go.mod', false], ['README.md', false]],
  web: [['src', true], ['package.json', false], ['vite.config.ts', false]],
  'web/src': [['charts', true], ['format', true], ['settings', true], ['main.tsx', false]],
  'web/src/charts': [['HourlyChart.tsx', false], ['tooltip.ts', false], ['tooltip.test.ts', false]],
}

function seedCodeAnswers() {
  const at = 'plugin:agent-tools|'
  answer(`${at}project_list_dir`, (a) => {
    const rel = String(a.rel ?? '')
    return {
      entries: (TREE[rel] ?? []).map(([name, isDir]) => ({ name, relPath: rel ? `${rel}/${name}` : name, isDir })),
      truncated: false,
    }
  })
  answer(`${at}project_read_file`, (a) => {
    const rel = String(a.rel ?? '')
    const content = rel.endsWith('tooltip.ts')
      ? TOOLTIP_NOW
      : `// ${rel}\nexport {}\n`
    return { relPath: rel, size: content.length, content, oversized: false, binary: false }
  })
  answer('agent_git_head_file', (a) => (String(a.path).endsWith('tooltip.ts') ? TOOLTIP_HEAD : null))
  answer('agent_git_blame', (a) => ({
    porcelain: String(a.path).endsWith('tooltip.ts') ? blamePorcelain() : null,
    webUrl: 'https://github.com/acme/weather',
  }))
  answer('agent_git_status', (a) => {
    const radar = String(a.project) === RADAR_TREE
    const files = radar
      ? [
          ['internal/radar/client.go', 'modified', 12, 4],
          ['internal/radar/client_test.go', 'modified', 7, 0],
        ]
      : [['web/src/charts/tooltip.ts', 'modified', 5, 2]]
    return {
      branch: radar ? 'flint/radar-retry' : 'main',
      repoRoot: String(a.project),
      files: files.map(([path, status, additions, deletions]) => ({
        path, origPath: null, status, staged: false, unstaged: true, additions, deletions, binary: false,
      })),
      additions: files.reduce((n, f) => n + Number(f[2]), 0),
      deletions: files.reduce((n, f) => n + Number(f[3]), 0),
    }
  })
  answer('agent_git_file_diff', (a) => ({
    diff: String(a.path).endsWith('client.go')
      ? [
          'diff --git a/internal/radar/client.go b/internal/radar/client.go',
          '--- a/internal/radar/client.go',
          '+++ b/internal/radar/client.go',
          '@@ -39,10 +39,18 @@ func (c *Client) Fetch(ctx context.Context, region string) (*Frame, error) {',
          ' \treq, err := c.newRequest(ctx, region)',
          ' \tif err != nil {',
          ' \t\treturn nil, err',
          ' \t}',
          '-\tresp, err := c.http.Do(req)',
          '-\tif err != nil {',
          '-\t\treturn nil, err',
          '-\t}',
          '+\tvar resp *http.Response',
          '+\terr = retry.Do(ctx, retry.Policy{Attempts: 3, Base: 250 * time.Millisecond, Jitter: true},',
          '+\t\tfunc() (err error) {',
          '+\t\t\tresp, err = c.http.Do(req)',
          '+\t\t\treturn err',
          '+\t\t})',
          '+\tif err != nil {',
          '+\t\t// Serve the last good frame rather than a blank map.',
          '+\t\treturn c.cache.Latest(ctx, region)',
          '+\t}',
          ' \tdefer resp.Body.Close()',
          ' \treturn decodeFrame(resp.Body)',
          ' }',
        ].join('\n')
      : '',
    binary: false,
    truncated: false,
  }))
  // Review only output: the sandbox and what applying each file would do.
  answer(`${at}session_workspace_path`, (a) =>
    `${PREVIEW_DATA_FOLDER}\\agent-workspace\\sessions\\${String(a.sessionId)}`
  )
  answer('agent_sandbox_apply_probe', (a) =>
    String(a.destination ?? a.path).endsWith('tooltip.ts') ? 'differs' : 'new'
  )
  answer('agent_sandbox_apply_file', () => 'created')
  answer('agent_sandbox_apply_hunk', () => 'applied')
  answer('agent_pr_status', (a) => usePrStatusStore.getState().byFolder[String(a.project)]?.lookup ?? { kind: 'no_pull_request' })
}

function seedCowork() {
  const session = (id: string, title: string, age: number, folder: string | null) => ({
    id,
    title,
    folder,
    turns: [
      { role: 'user', content: title, startedAt: now - age * MIN },
      { role: 'assistant', content: 'Working on it.', startedAt: now - age * MIN, endedAt: now - (age - 1) * MIN, usage: { completion_tokens: 18_400 } },
    ],
    messages: [],
    updated: now - age * MIN,
    model: { provider: 'llamacpp', id: 'qwen3-8b-instruct' },
  })
  const p = params()
  const current = p.get('session') ?? 'escape'
  const sessions = [
    escapeSession(),
    dashSession(),
    reviewSession(),
    session('changelog', 'Draft 1.4 changelog', 50, JAN),
    unitsSession(),
    session('sync', 'Write the API guide', 3000, null),
    ...nestedPreviewSessions((id, title, age) => session(id, title, age, null)),
  ]
  useCoworkSessions.setState({ sessions: sessions as never, currentId: current } as never)
  useCoworkRun.setState({ runs: { escape: { startedAt: now - 8 * MIN } } } as never)
  seedPrs()
  seedGroups()
  if (p.get('queue')) seedQueue()
  seedOrigins()
  seedCodeAnswers()
  seedStudioAnswers()
  // The running session works in a managed worktree, and so did the units
  // run. The web build cannot ask the backend what it can confine, so the
  // answer is given here -- and given again when the page's own query fails.
  const tree = (path: string, branch: string) => ({
    path,
    branch,
    baseSha: 'a41c9e2',
    sourceRoot: JAN,
    identity: {} as never,
    uncommittedAtCreation: [],
  })
  useCoworkWorktrees.setState({
    bySession: {
      escape: tree(RADAR_TREE, 'flint/radar-retry'),
      paths: tree(UNITS_TREE, 'flint/units-api'),
    },
  } as never)
  const grant = () =>
    useDirectEditGrants.setState({
      capability: { known: true, directEdit: true, managedWorktree: true },
      bySession: {
        escape: { sessionId: 'escape', folder: RADAR_TREE, grantId: 'preview' },
        dash: { sessionId: 'dash', folder: JAN, grantId: 'preview-dash' },
      },
    } as never)
  grant()
  useDirectEditGrants.subscribe((s) => {
    if (!s.capability.known) grant()
  })
  // Pending approval for the push, in the running session.
  if (!useToolApprovalRequests.getState().pending.e6) {
    useToolApprovalRequests.setState((s) => ({
      pending: {
        ...s.pending,
        e6: {
          requestId: 'preview-e6',
          toolCallId: 'e6',
          toolName: 'bash',
          threadId: 'escape',
          input: { command: 'git push -u origin flint/radar-retry && gh pr create --fill' },
          taskContext: 'Push the branch and open a pull request for the retry fix.',
          workspaceLabel: 'acme-weather (worktree radar-retry)',
          requestedAt: now - 20_000,
          resolve: () => {},
        },
      },
    }))
  }
  const view = useCoworkView.getState()
  const rail = p.get('rail')
  view.setRail(
    'escape',
    rail === 'none'
      ? null
      : rail === 'browser'
        ? { kind: 'browser' }
        : rail === 'preview'
          ? { kind: 'preview' }
          : { kind: 'diff' }
  )
  if (rail === 'browser') seedBrowserPane('escape')
  view.setRail('dash', { kind: 'code' })
  view.setRail('paths', null)
  const split = p.get('split')
  if (split) {
    useSplitConversation.setState({
      // `split=chat:<thread>` or `split=cowork:<session>`
      panes: [{ id: 'p1', kind: split.split(':')[0], refId: split.split(':')[1] }],
      sizes: [0.56, 0.44],
      activePane: 'primary',
    } as never)
  }
}

/**
 * The web services start empty and the app re-reads them on mount, which
 * would replace the seeded stores; answer those reads with the example data.
 * The hub keeps one instance per service, so the instances are patched, again
 * on every pass in case the hub was replaced.
 */
let subscribed = false
/** Invented contents of the Library's seeded artifacts (previewSeedEngine). */
const LIBRARY_FILES: Record<string, string> = {
  'CHANGELOG.md': [
    '# Changelog',
    '',
    '## 1.4.0',
    '',
    '### Added',
    '- **Wind gusts** on the hourly chart',
    '- Units follow the device locale',
    '',
    '### Fixed',
    '- Forecast cache keyed by UTC date, not local date',
    '- Tooltip no longer clips at the chart edge',
  ].join('\n'),
  'docs/api-guide.md': [
    '# acme-weather API guide',
    '',
    'Every endpoint returns JSON and takes an `apiKey` query parameter.',
    '',
    '## GET /forecast',
    '',
    'Returns the next 7 days for a city. Temperatures are in the unit the',
    'caller asked for, `metric` by default.',
  ].join('\n'),
  'out/retry_report.html':
    '<!doctype html><html><head><title>Retry report</title><style>body{font:14px sans-serif}</style></head><body><h1>Retry report</h1><p>312 requests retried in the last 24 hours.</p><p>Most retries came from the radar tile service between 02:00 and 03:00 UTC.</p><ul><li>radar: 241</li><li>forecast: 58</li><li>alerts: 13</li></ul></body></html>',
  'out/palette-preview.html':
    '<!doctype html><html><head><title>Dashboard palette</title></head><body><h2>Dashboard color palette</h2><p>Six categorical hues, checked for contrast in light and dark.</p><p>Primary: indigo 500. Accent: emerald 500.</p></body></html>',
}

function patchServices() {
  const hub = useServiceStore.getState().serviceHub as unknown as Record<string, Record<string, unknown>> | null
  if (!subscribed) {
    subscribed = true
    useServiceStore.subscribe(() => patchServices())
  }
  if (!hub) return
  const set = (service: string, method: string, fn: (...a: never[]) => Promise<unknown>) => {
    const target = hub[service]
    if (target) target[method] = fn
  }
  set('messagesService', 'fetchMessages', async (id: string) => {
    if (id === 'release') return releaseMessages()
    if (id === 'escape' || id === 'toolargs') return toolArgsMessages(id)
    const chat = CHATS.find((c) => c[0] === id)
    return chat && /^(plan\d|longtitle|mdshow)$/.test(id) ? fillerMessages(id, chat[1]) : []
  })
  set('projectsService', 'getProjects', async () => FOLDERS)
  set('threadsService', 'fetchThreads', async () => (params().has('empty') ? [] : threads()))
  set('assistantsService', 'getAssistants', async () => assistants())
  // The Review only session's sandbox copy, readable the way the Code panel
  // reads sandbox files.
  const core = hub.coreService as Record<string, unknown> | undefined
  if (core && !core.previewPatched) {
    const original = core.convertFileSrc as (p: string) => string
    core.previewPatched = true
    core.convertFileSrc = (path: string) => {
      const p = path.replace(/\\/g, '/')
      if (p.endsWith('sessions/review/acme-weather/web/src/charts/tooltip.ts'))
        return `data:text/plain;charset=utf-8,${encodeURIComponent(reviewTooltip())}`
      // Library card previews: invented file contents for the seeded artifacts.
      const file = Object.keys(LIBRARY_FILES).find((f) => p.endsWith(`/${f}`))
      return file
        ? `data:text/plain;charset=utf-8,${encodeURIComponent(LIBRARY_FILES[file])}`
        : original.call(core, path)
    }
  }
  patchSettingsServices(hub)
}

/** Read by hooks that would otherwise ask the backend (dev builds only). */
function seedBackendAnswers() {
  const w = window as unknown as { __flintPreview?: object }
  w.__flintPreview = {
    memoryProposals: [
      {
        id: 'prop-1',
        content: 'acme-weather keys cached forecasts by UTC date.',
        scope: 'project',
        reason: 'automatic-saving-disabled',
        explanation: 'Automatic saving is off, so Flint asks before remembering anything.',
        approvable: true,
        sourceSessionId: 'release',
        sourceMessageId: 'm2',
        createdAt: now - 2 * MIN,
      },
    ],
  }
}

function seedMentionDraft(many: boolean) {
  const chat = (id: string) => `@${mentionToken('chat', id, CHATS.find((c) => c[0] === id)?.[1] ?? id)}`
  const session = `@${mentionToken('session', 'dash', 'Hourly chart tooltip')}`
  const prompt = many
    ? `Compare ${chat('kravio')} ${chat('escape')} ${session} ${chat('longtitle')} ${chat('toolargs')} ${chat('sandbox')} and @chat:deleted-thread-0badf00d#summary`
    : `What did we settle in ${chat('kravio')} and ${session}? Use it for the new legend.`
  void import('@/hooks/usePrompt').then((m) => m.usePrompt.getState().setPrompt(prompt))
}

function seedHeavy() {
  const n = Number(params().get('heavy')) || 2000
  const list: Thread[] = []
  for (let i = 0; i < n; i++) {
    list.push({
      id: `heavy-${i}`,
      title: `Heavy chat ${i} about ${['rust', 'react', 'sql', 'docker'][i % 4]}`,
      // Spread across the last 60 days; the first 30 inside the "recent" hour.
      updated: (now - (i < 30 ? i : i * 43) * MIN) / 1000,
      isFavorite: i % 97 === 0,
      assistants: [],
      model: { id: 'claude-sonnet-5', provider: 'anthropic' },
      metadata: {},
    } as unknown as Thread)
  }
  useThreads.getState().setThreads([...threads(), ...list])
  const code = '```ts\n' + Array.from({ length: 40 }, (_, k) => `const v${k} = compute(${k}) // line ${k}`).join('\n') + '\n```'
  const table = '| a | b | c |\n|---|---|---|\n' + Array.from({ length: 20 }, (_, k) => `| ${k} | ${k * 2} | ${k * 3} |`).join('\n')
  const msgs = Array.from({ length: 300 }, (_, i) => ({
    id: `heavy-m-${i}`,
    object: 'thread.message',
    thread_id: 'heavy-0',
    role: i % 2 ? 'assistant' : 'user',
    created_at: now - (300 - i) * MIN,
    completed_at: now - (300 - i) * MIN,
    content: [text(i % 2 ? `## Answer ${i}\n\nSome **markdown** text.\n\n${code}\n\n${table}` : `Question ${i}?`)],
  })) as unknown as ThreadMessage[]
  useMessages.getState().setMessages('heavy-0', msgs)
  ;(window as unknown as Record<string, unknown>).__flintPerf = { useThreads, useMessages }
}

export function seedPreview() {
  seedBackendAnswers()
  patchServices()
  useModelProvider.setState({
    providers: providers(),
    selectedProvider: 'llamacpp',
    selectedModel: model('qwen3-8b-instruct', 'Qwen3 8B Instruct', ['tools', 'reasoning']),
  } as never)
  useThreads.getState().setThreads(threads())
  useThreads.setState({ isLoadingThreads: false } as never)
  useMessages.getState().setMessages('release', releaseMessages())
  useAppState.setState({
    activeModels: ['qwen3-8b-instruct', 'claude-sonnet-5', 'gpt-5-mini'],
    tools: mcpTools(),
  } as never)
  useAssistant.setState({ assistants: assistants(), loading: false } as never)
  if (useOnboardingGuide.getState().status !== 'in-progress') {
    useOnboardingGuide.getState().start('question', CHATS.length)
  }
  seedToolRuntime()
  seedUsage()
  seedCowork()
  seedRooms()
  seedApplyReviewPreview(params().get('applyseed'))
  seedEngine()
  seedHuggingFacePreview()
  seedSettingsPreview()
  seedRichSearch()
  seedNestingState()
  // `?heavy`: a big data folder for performance runs (2,000 chats, one
  // 300-message chat with code and tables), stores exposed on window.
  if (params().has('heavy')) seedHeavy()
  // `?empty`: no conversation anywhere, to look at the @ / # menus' empty state.
  if (params().has('empty')) {
    useThreads.setState({ threads: {} } as never)
    useCoworkSessions.setState({ sessions: [], currentId: null } as never)
    setRoomPersistence({ listRooms: async () => [] } as unknown as RoomPersistence)
    useRoomsStore.setState({ summaries: [] } as never)
  }
  // `?mentions`: a draft that mentions conversations, to look at the composer's
  // mention pills and chips; `?mentions=many` mentions more than the cap, and
  // one conversation that no longer exists.
  if (params().has('mentions')) seedMentionDraft(params().get('mentions') === 'many')
  // Folders live in a store the hook reads through the projects service; the
  // hook's own setter is reached from its module.
  void import('@/hooks/useThreadManagement').then((m) => {
    const store = (m as unknown as { useThreadManagementStore?: { setState: (s: object) => void } }).useThreadManagementStore
    store?.setState({ folders: FOLDERS })
  })
  try {
    localStorage.setItem('setup-completed', 'true')
    localStorage.setItem('recent-searches', JSON.stringify(['forecast cache', 'radar', 'units']))
  } catch {
    // Storage may be unavailable; the providers alone pass the setup gate.
  }
}
