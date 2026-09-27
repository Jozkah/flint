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
import { useAssistant } from '@/hooks/useAssistant'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import { usePrStatusStore } from '@/stores/pr-status-store'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useCoworkOrigins } from '@/hooks/useCoworkOrigins'
import { useSplitConversation } from '@/hooks/useSplitConversation'
import { useConversationGroups } from '@/lib/groups/store'
import { projectKeyOf } from '@/lib/coworkCode'
import { answer } from './previewTauri'
import { seedRooms } from './previewRooms'
import { seedEngine } from './previewSeedEngine'
import { patchSettingsServices, seedSettingsPreview } from './previewSeedSettings'

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

/** The example assistants: Flint, and two the user made. */
function assistants(): Assistant[] {
  const flint = useAssistant.getState().assistants.find((a) => a.id === 'jan')
  const base = { created_at: now / 1000, description: '', instructions: '', parameters: {} }
  return [
    ...(flint ? [flint] : []),
    { ...base, id: 'go-reviewer', name: 'Go reviewer', avatar: '🐹' },
    { ...base, id: 'changelog', name: 'Changelog writer', avatar: '✍️' },
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
]

function threads(): Thread[] {
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
      content: [text('The /v1/forecast endpoint keeps returning yesterday’s data after midnight UTC. Can you find out why and fix it?')],
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
  return {
    id: 'escape',
    title: 'Retry the radar feed',
    folder: JAN,
    mode: 'ask',
    access: 'managed-worktree',
    turns,
    subagents: [],
    todos: {
      phases: [
        {
          name: 'Fix',
          tasks: [
            { content: 'Read the radar client', status: 'completed' },
            { content: 'Reproduce the timeout with a failing test', status: 'completed' },
            { content: 'Add retry with backoff and a cached fallback', status: 'completed' },
            { content: 'Open a pull request', status: 'in_progress' },
          ],
        },
      ],
    },
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

function seedPrs() {
  usePrStatusStore.setState({
    byFolder: {
      [RADAR_TREE]: pr(12, 'Retry the radar feed with backoff', 'open', 'flint/radar-retry', 35, 4, { passed: 3, failed: 0, pending: 1 }),
      [UNITS_TREE]: pr(11, 'Add imperial units to /v1/forecast', 'merged', 'flint/units-api', 128, 12, { passed: 4, failed: 0, pending: 0 }),
    },
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
    session('changelog', 'Draft 1.4 changelog', 50, JAN),
    unitsSession(),
    session('sync', 'Write the API guide', 3000, null),
  ]
  useCoworkSessions.setState({ sessions: sessions as never, currentId: current } as never)
  useCoworkRun.setState({ runs: { escape: { startedAt: now - 8 * MIN } } } as never)
  seedPrs()
  seedGroups()
  if (p.get('queue')) seedQueue()
  seedOrigins()
  seedCodeAnswers()
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
  view.setRail('escape', p.get('rail') === 'none' ? null : { kind: 'diff' })
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
  set('messagesService', 'fetchMessages', async (id: string) => (id === 'release' ? releaseMessages() : []))
  set('projectsService', 'getProjects', async () => FOLDERS)
  set('threadsService', 'fetchThreads', async () => threads())
  set('assistantsService', 'getAssistants', async () => assistants())
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
  seedEngine()
  seedSettingsPreview()
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
