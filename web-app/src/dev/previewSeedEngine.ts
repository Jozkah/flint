/**
 * Development-only preview data for the engine pages (Library, Models,
 * provider pages, Tools & MCP, Extensions), taken from the design mockup's
 * own example content. Called by `seedPreview` in ./previewSeed.ts, so it
 * runs only with `?preview` in a development build.
 */
import { useModelProvider } from '@/hooks/useModelProvider'
import { useAppState } from '@/hooks/useAppState'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useMCPServers, type MCPServers } from '@/hooks/useMCPServers'
import { useToolApproval } from '@/hooks/useToolApproval'
import { useServiceStore } from '@/hooks/useServiceHub'
import {
  useEngineActivity,
  type GenerationSample,
  type ToolCallSample,
} from '@/stores/engine-activity-store'

const MIN = 60_000
const GB = 1024 ** 3

/** A deterministic wobble, so screenshots are stable between runs. */
const wobble = (i: number, seed: number) =>
  Math.sin(i * 0.45 + seed) * 0.55 + Math.sin(i * 1.3 + seed * 2.1) * 0.25

/* ---------- models ---------- */

const CTX: Record<string, number> = {
  'qwen3-8b-instruct': 32768,
  'gemma-3-12b-it-Q5_K_M': 8192,
  'llama-3.1-8b': 131072,
  'Mistral-Small-3.2-24B-Q4_K_S': 32768,
  'phi-4-mini-Q8_0': 131072,
  'claude-sonnet-5': 200000,
  'claude-opus-5-5': 200000,
  'claude-haiku-4-5': 200000,
  'gpt-5': 400000,
  'gpt-5-mini': 400000,
  'gemini-3-pro': 1000000,
}

const SIZES: Record<string, number> = {
  'qwen3-8b-instruct': 8.4 * GB,
  'gemma-3-12b-it-Q5_K_M': 8.9 * GB,
  'llama-3.1-8b': 7.9 * GB,
  'Mistral-Small-3.2-24B-Q4_K_S': 13.5 * GB,
  'phi-4-mini-Q8_0': 4.3 * GB,
}

/** Average speed per model id (tok/s), from the mockup's Models table. */
const SPEEDS: Record<string, [avg: number, provider: string]> = {
  'qwen3-8b-instruct': [48.6, 'llamacpp'],
  'gemma-3-12b-it-Q5_K_M': [39.4, 'llamacpp'],
  'phi-4-mini-Q8_0': [92.1, 'llamacpp'],
  'llama-3.1-8b': [31.2, 'llamacpp'],
  'Mistral-Small-3.2-24B-Q4_K_S': [22.8, 'llamacpp'],
  'gpt-5': [61.2, 'openai'],
  'gpt-5-mini': [88.4, 'openai'],
  'claude-sonnet-5': [42.3, 'anthropic'],
}

function seedModels() {
  const state = useModelProvider.getState()
  const providers = (state.providers ?? []).map((p) => ({
    ...p,
    models: p.models.map((m) => ({
      ...m,
      displayName: m.displayName ?? m.name,
      ...(CTX[m.id]
        ? {
            settings: {
              ...(m.settings ?? {}),
              ctx_len: {
                key: 'ctx_len',
                controller_props: { value: CTX[m.id] },
              },
            },
          }
        : {}),
    })),
  })) as ModelProvider[]
  for (const [provider, base_url] of [
    ['mistral', 'https://api.mistral.ai/v1'],
    ['groq', 'https://api.groq.com/openai/v1'],
  ] as const) {
    if (!providers.some((p) => p.provider === provider)) {
      providers.push({
        provider,
        active: false,
        api_key: '',
        base_url,
        settings: [],
        models: [],
      } as unknown as ModelProvider)
    }
  }
  useModelProvider.setState({ providers } as never)
  useAppState.setState({
    activeModels: [
      'qwen3-8b-instruct',
      'gemma-3-12b-it-Q5_K_M',
      'phi-4-mini-Q8_0',
    ],
  } as never)
}

/* ---------- engine activity (speeds, tool calls) ---------- */

const SERVER_LOAD: Record<string, [perMin: number, spread: number]> = {
  'filesystem': [11, 5],
  'github': [20, 9],
  'you-search': [2, 2],
}
const TOOLS: Record<string, string[]> = {
  'filesystem': ['read_file', 'write_file', 'list_directory', 'search_files'],
  'github': [
    'create_issue',
    'create_pull_request',
    'list_commits',
    'get_file_contents',
  ],
  'you-search': ['search', 'fetch'],
}

function seedActivity() {
  const now = Date.now()
  const generations: GenerationSample[] = []
  // One model after another, the way a day of chats runs, so the most
  // recent replies read as one steady line.
  const entries = Object.entries(SPEEDS)
  entries.forEach(([model, [avg, provider]], k) => {
    for (let i = 0; i < 24; i++) {
      generations.push({
        at: now - ((entries.length - k) * 24 - i) * 2 * MIN,
        model,
        provider,
        tps: Math.max(1, avg * (1 + wobble(i, k) * 0.14)),
      })
    }
  })
  generations.sort((a, b) => a.at - b.at)

  const toolCalls: ToolCallSample[] = []
  let n = 0
  for (const [server, [perMin, spread]] of Object.entries(SERVER_LOAD)) {
    const tools = TOOLS[server]
    for (let m = 0; m < 20; m++) {
      const count = Math.max(0, Math.round(perMin + wobble(m, perMin) * spread))
      for (let c = 0; c < count; c++) {
        toolCalls.push({
          at: now - (20 - m) * MIN + (c * MIN) / (count + 1),
          server,
          tool: tools[(m + c) % tools.length],
          ok: ++n % 41 !== 0,
        })
      }
    }
  }
  toolCalls.sort((a, b) => a.at - b.at)
  useEngineActivity.setState({ generations, toolCalls })
}

/* ---------- MCP servers ---------- */

const SERVERS: MCPServers = {
  'filesystem': {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Projects'],
    env: {},
    active: true,
  },
  'github': {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'preview' },
    active: true,
  },
  'playwright': {
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    env: {},
    active: true,
  },
  'you-search': {
    command: '',
    args: [],
    env: {},
    type: 'http',
    url: 'https://api.you.com/mcp',
    active: true,
  },
  'browser-search': {
    command: 'npx',
    args: ['-y', 'search-mcp-server@latest'],
    env: {},
    active: false,
    official: true,
  },
  'sequential-thinking': {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: {},
    active: false,
  },
}

function seedMcp() {
  useMCPServers.setState({ mcpServers: SERVERS } as never)
  useToolApproval.setState({
    approvedServers: [{ name: 'filesystem', fingerprint: 'fp-filesystem' }],
  } as never)
}

/* ---------- artifacts (Cowork write calls) ---------- */

type Art = [
  session: string,
  title: string,
  path: string,
  bytes: number,
  ageMin: number,
]
const ARTIFACTS: Art[] = [
  ['changelog', 'Draft 1.4 changelog', 'CHANGELOG.md', 2100, 40],
  [
    'sync',
    'Write the API guide',
    'docs/radar-retry.svg',
    5200,
    2,
  ],
  ['sync', 'Write the API guide', 'out/retry_report.html', 9400, 4],
  ['sync', 'Write the API guide', 'charts/temp-by-city.png', 88000, 1500],
  ['sync', 'Write the API guide', 'docs/units-flow.svg', 1900, 1500],
  ['sync', 'Write the API guide', 'docs/api-guide.md', 11200, 4300],
  [
    'changelog',
    'Draft 1.4 changelog',
    'out/standup-summary.mp3',
    2_140_000,
    4300,
  ],
  ['kravio', 'Dashboard color palette', 'out/palette-preview.html', 48000, 20],
]

function seedArtifacts() {
  const now = Date.now()
  const state = useCoworkSessions.getState() as unknown as {
    sessions: Array<{
      id: string
      title: string
      turns: unknown[]
      updated: number
    }>
  }
  const sessions = [...(state.sessions ?? [])]
  for (const [id, title, path, bytes, age] of ARTIFACTS) {
    let s = sessions.find((x) => x.id === id)
    if (!s) {
      s = {
        id,
        title,
        folder: null,
        turns: [{ role: 'user', content: title, startedAt: now - age * MIN }],
        messages: [],
        updated: now - age * MIN,
        model: { provider: 'anthropic', id: 'claude-sonnet-5' },
      } as never
      sessions.push(s!)
    }
    const turns = s!.turns as Array<{ args?: { path?: string } }>
    if (turns.some((t) => t.args?.path === path)) continue
    s!.turns = [
      ...turns,
      {
        role: 'tool',
        name: 'write',
        content: '',
        callId: `w-${path}`,
        args: { path },
        result: `Created ${path} (${bytes} bytes)`,
        status: 'done',
        toolState: 'succeeded',
        startedAt: now - age * MIN,
        endedAt: now - age * MIN,
      },
    ]
  }
  useCoworkSessions.setState({ sessions } as never)
}

/* ---------- plugins and skills (Tauri commands) ---------- */

type Plug = [
  id: string,
  version: string,
  description: string,
  repo: string,
  enabled: boolean,
  skills: string[],
  commands: number,
  agents: number,
  kind: 'local' | 'git' | 'marketplace',
  source: string,
]
const PLUGINS: Plug[] = [
  [
    'flint-core',
    '1.4.0',
    'Skills for Go, git and testing.',
    '',
    true,
    ['go-testing', 'git-hygiene', 'go-watch'],
    2,
    0,
    'local',
    'C:\\Projects\\flint-core',
  ],
  [
    'release-kit',
    '0.3.2',
    'Changelog and release-note helpers.',
    'https://github.com/acme/release-kit',
    true,
    ['changelog', 'release-notes'],
    0,
    1,
    'git',
    'https://github.com/acme/release-kit',
  ],
  [
    'design-kit',
    '0.9.0',
    'Frontend and artifact design skills.',
    'https://github.com/flint/design-kit',
    false,
    ['frontend-design', 'artifact-design', 'palette', 'type-scale'],
    0,
    0,
    'marketplace',
    'design-kit',
  ],
  [
    'data-kit',
    '0.2.1',
    'CSV, SQL and chart helpers.',
    '',
    true,
    ['csv-clean', 'sql-helper', 'chart-quick'],
    0,
    0,
    'local',
    'C:\\Projects\\data-kit',
  ],
]
const installed = (p: Plug) => ({
  id: p[0],
  name: p[0],
  description: p[2],
  version: p[1],
  repo: p[3],
  skills: p[5].length,
  commands: p[6],
  agents: p[7],
  enabled: p[4],
  sourceKind: p[8],
  source: p[9],
})
const SKILLS: Array<[name: string, description: string, plugin?: string]> = [
  ['go-testing', 'Run and read go tests', 'flint-core'],
  ['git-hygiene', 'Commit and branch conventions', 'flint-core'],
  ['changelog', 'Write release notes', 'release-kit'],
  ['frontend-design', 'Build polished UI', 'design-kit'],
  ['csv-clean', 'Clean up CSV exports', 'data-kit'],
  ['go-watch', 'Keep a build running', 'flint-core'],
]
/** Skills kept in a project's own folder. */
const PROJECT_SKILLS = [
  { name: 'weather-release', description: 'Cut an acme-weather release' },
]
const MARKET = [
  ['obsidian-bridge', 'Read and write your Obsidian vault.'],
  ['sql-helper', 'Query SQLite and Postgres safely.'],
  ['figma-context', 'Pull design context from Figma files.'],
  ['k8s-ops', 'Inspect clusters with read-only tools.'],
]
const PROJECTS = [{ id: 'weather', folder: 'C:\\Projects\\acme-weather', name: 'acme-weather' }]

function previewInvoke(
  command: string,
  args?: Record<string, unknown>
): Promise<unknown> | undefined {
  const ok = (v: unknown) => Promise.resolve(v)
  switch (command) {
    case 'agent_plugin_list':
      return ok(PLUGINS.map(installed))
    case 'agent_plugin_details': {
      const p = PLUGINS.find((x) => x[0] === args?.id) ?? PLUGINS[0]
      return ok({
        ...installed(p),
        installedPath: `%APPDATA%\\flint\\plugins\\${p[0]}`,
        installedAtMs: Date.now() - 6 * 86_400_000,
        gitRef: p[8] === 'git' ? 'main' : null,
        skillNames: p[5],
        commandNames: Array.from(
          { length: p[6] },
          (_, i) => ['build', 'test'][i] ?? `cmd-${i}`
        ),
        agentNames: p[7] ? ['release-captain'] : [],
        hasMcpConfig: p[0] === 'data-kit',
        executableFiles: [],
        executableFileCount: 0,
      })
    }
    case 'agent_plugin_sources':
      return ok({ marketplace: 'https://plugins.flint.dev/index.json' })
    case 'agent_plugin_search':
      return ok(
        MARKET.map(([name, description]) => ({
          name,
          description,
          repo: `https://github.com/flint/${name}`,
          ref: null,
        }))
      )
    case 'agent_skill_list':
      return ok(
        args?.store
          ? SKILLS.map(([name, description, plugin]) => ({
              name: plugin ? `${plugin}:${name}` : name,
              description,
              plugin,
            }))
          : PROJECT_SKILLS
      )
    case 'agent_skill_read':
      return ok(
        `---\ndescription: Run and read go tests\n---\n\n# Go testing\n\n1. Run \`go vet ./...\` first.\n2. Run \`go test ./... -count=1\`.\n3. Quote the shortest failing line, never the whole log.\n`
      )
    case 'agent_projects_list':
      return ok(PROJECTS)
    case 'agent_extensions_matrix_get':
      return ok({
        skills: { 'git-hygiene': { surfaces: ['home', 'rooms'] } },
        plugins: {
          'flint-core': { surfaces: ['home', 'rooms'] },
          'release-kit': { surfaces: ['home', 'rooms', 'cowork:weather'] },
          'data-kit': { surfaces: ['home', 'rooms', 'cowork:weather'] },
        },
      })
    case 'agent_extensions_matrix_set_item':
      return ok({ skills: {}, plugins: {} })
    case 'agent_skill_enabled_get':
      return ok([])
    default:
      return undefined
  }
}

/* ---------- services ---------- */

function patchEngineServices() {
  const hub = useServiceStore.getState().serviceHub as unknown as Record<
    string,
    Record<string, unknown>
  > | null
  if (!hub) return
  const set = (
    service: string,
    method: string,
    fn: (...a: never[]) => Promise<unknown>
  ) => {
    const target = hub[service]
    if (target) target[method] = fn
  }
  const connected = ['filesystem', 'github']
  set('mcpService', 'getConnectedServers', async () => connected)
  set('mcpService', 'getToolsForServers', async (names: string[]) =>
    names.flatMap((server) =>
      (server === 'github'
        ? [
            ...TOOLS.github,
            ...Array.from({ length: 22 }, (_, i) => `github_tool_${i + 1}`),
          ]
        : (TOOLS[server] ?? [])
      ).map((name) => ({ name, server, description: '', inputSchema: {} }))
    )
  )
  set('mcpService', 'serverFingerprints', async () =>
    Object.fromEntries(Object.keys(SERVERS).map((k) => [k, `fp-${k}`]))
  )
  set('mcpService', 'getMCPAuthStatus', async (name: string) => ({
    state: name === 'you-search' ? 'unauthenticated' : 'notApplicable',
    canAuthenticate: name === 'you-search',
    hasCredentials: false,
    renewable: false,
  }))
  set('mcpService', 'activateMCPServer', async () => undefined)
  set('mcpService', 'deactivateMCPServer', async () => undefined)
  set('modelsService', 'fetchModels', async () =>
    Object.entries(SIZES).map(([id, sizeBytes]) => ({
      id,
      sizeBytes,
      providerId: 'llamacpp',
      path: `C:\\Users\\me\\AppData\\Roaming\\flint\\llamacpp\\models\\${id}.gguf`,
    }))
  )
  set(
    'modelsService',
    'getActiveModels',
    async () => useAppState.getState().activeModels ?? []
  )
}

/** The built-in extensions the desktop app loads, for the Engine tab. */
const ENGINE_EXTENSIONS = [
  [
    '@janhq/assistant-extension',
    'Jan Assistant',
    '1.0.2',
    'Powers the default AI assistant that works with all your installed models.',
  ],
  [
    '@janhq/conversational-extension',
    'Conversational',
    '1.0.0',
    'Enables conversations and state persistence via your file system.',
  ],
  [
    '@janhq/llamacpp-extension',
    'llama.cpp Inference Engine',
    '1.0.1',
    'This extension enables llama.cpp chat completion API calls',
  ],
  [
    '@janhq/mlx-extension',
    'MLX Inference Engine',
    '1.0.0',
    'This extension enables MLX-Swift inference on Apple Silicon Macs',
  ],
  [
    '@janhq/rag-extension',
    'RAG Tools',
    '0.1.0',
    'Registers RAG tools and orchestrates retrieval across parser, embeddings, and vector DB',
  ],
  [
    '@janhq/vector-db-extension',
    'Vector DB',
    '0.1.0',
    'Vector DB integration using sqlite-vec if available with linear fallback',
  ],
]

function seedExtensions() {
  void import('@/lib/extension').then(({ ExtensionManager }) => {
    const map = (
      ExtensionManager.getInstance() as unknown as {
        extensions: Map<string, unknown>
      }
    ).extensions
    if (!map || map.size > 0) return
    for (const [name, productName, version, description] of ENGINE_EXTENSIONS) {
      map.set(name, {
        name,
        productName,
        version,
        description,
        type: () => undefined,
        onLoad: () => undefined,
        onUnload: () => undefined,
      })
    }
  })
}

let subscribed = false
export function seedEngine() {
  const win = window as unknown as {
    __FLINT_PREVIEW_INVOKE__?: typeof previewInvoke
  }
  win.__FLINT_PREVIEW_INVOKE__ = previewInvoke
  seedExtensions()
  if (!subscribed) {
    subscribed = true
    useServiceStore.subscribe(() => patchEngineServices())
  }
  patchEngineServices()
  seedModels()
  seedActivity()
  seedMcp()
  seedArtifacts()
}
