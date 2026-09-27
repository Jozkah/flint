/**
 * Development-only preview data for Settings, the System Monitor and the Logs
 * pages (see previewSeed.ts): the design mockup's example memories, grants,
 * hardware, usage and log lines. Never imported in production builds.
 */
import { useHardware, type HardwareData, type SystemUsage } from '@/hooks/useHardware'
import { useToolApproval } from '@/hooks/useToolApproval'
import { useAssistant } from '@/hooks/useAssistant'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useAttachments } from '@/hooks/useAttachments'
import type { LogEntry } from '@/services/app/types'
import { ExtensionTypeEnum } from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import { answer, installPreviewTauri } from './previewTauri'

const MIN = 60_000
const now = Date.now()
const sec = (ms: number) => Math.floor(ms / 1000)

export const PREVIEW_DATA_FOLDER = 'C:\\Users\\demo\\AppData\\Roaming\\flint'

/* ---------------- hardware and live usage ---------------- */

const GB = 1024 // the hardware plugin reports megabytes

const HARDWARE: HardwareData = {
  cpu: {
    arch: 'x86_64',
    core_count: 16,
    extensions: ['AVX', 'AVX2', 'AVX512F', 'FMA', 'F16C', 'SSE4.2'],
    instructions: ['AVX', 'AVX2', 'AVX512F', 'FMA', 'F16C', 'SSE4.2'],
    name: 'AMD Ryzen 7 7700 8-Core Processor',
    usage: 12.3,
  },
  gpus: [
    {
      name: 'NVIDIA GeForce RTX 4060',
      total_memory: 8 * GB,
      vendor: 'NVIDIA',
      uuid: 'GPU-4060',
      driver_version: '576.02',
      activated: true,
      nvidia_info: { index: 0, compute_capability: '8.9' },
      vulkan_info: { index: 0, device_id: 10118, device_type: 'DiscreteGpu', api_version: '1.4.303' },
    },
  ],
  os_type: 'windows',
  os_name: 'Windows 11 Pro',
  total_memory: 31.9 * GB,
  os: { name: 'windows', version: 'Windows 11 Pro' },
  ram: { available: 14.2 * GB, total: 31.9 * GB },
} as unknown as HardwareData

let tick = 0
function usage(): SystemUsage {
  tick++
  const wave = (base: number, amp: number, k: number) =>
    Math.max(3, Math.min(99, base + Math.sin(tick * k) * amp + (Math.random() - 0.5) * amp))
  const ram = wave(57, 2, 0.7) / 100
  const vram = wave(82, 4, 0.5) / 100
  return {
    cpu: wave(22, 9, 1.3),
    used_memory: Math.round(63.9 * GB * ram),
    total_memory: Math.round(63.9 * GB),
    gpus: [{ uuid: 'GPU-4060', used_memory: Math.round(8 * GB * vram), total_memory: 8 * GB }],
  }
}

/* ---------------- logs ---------------- */

const LOG_BASE: [LogEntry['level'], string, string][] = [
  ['info', 'llamacpp', 'Loaded qwen3-8b-instruct.gguf in 2.14s (41/41 layers on GPU)'],
  ['warn', 'hardware', 'VRAM at 95% (7.6 / 8 GB), reducing context to 24576'],
  ['info', 'mcp', 'filesystem connected, 4 tools'],
  ['error', 'agent', 'bash exited with code 1: go test ./internal/cache/... failed'],
  ['info', 'agent', 'bash allowed once in thread "Forecast cache returns stale data"'],
  ['debug', 'router', 'Routed 3 of 5 MCP servers for request 0x91f3 (github, filesystem, you-search)'],
  ['warn', 'mcp', 'playwright slow start (6.2s)'],
  ['info', 'proxy', 'POST /v1/chat/completions 200 · qwen3-8b-instruct · 1,284 tokens · 30.4s'],
  ['error', 'mcp', 'you-search: 401 Unauthorized, sign-in required'],
  ['info', 'llamacpp', 'Prompt cache hit: reused 28,900 of 31,204 tokens'],
  ['debug', 'agent', 'Compacted context: 31.2k → 6.4k tokens (summary 512)'],
  ['info', 'app', `Flint 0.9.0 started, data folder ${PREVIEW_DATA_FOLDER}`],
  ['info', 'updater', 'No update available (0.9.0 is the latest)'],
]

const TARGET: Record<string, string> = {
  llamacpp: 'app_lib::core::llamacpp',
  hardware: 'app_lib::core::hardware',
  mcp: 'app_lib::core::mcp',
  agent: 'app_lib::core::agent',
  router: 'app_lib::core::router',
  proxy: 'app_lib::core::server::proxy',
  app: 'app_lib::app',
  updater: 'app_lib::core::updater',
}

const SERVER_LOG: [LogEntry['level'], string][] = [
  ['info', 'server listening on http://127.0.0.1:1337/v1'],
  ['info', 'GET /v1/models 200 · 9 models'],
  ['warn', 'POST /v1/chat/completions 401 · missing bearer token from 127.0.0.1:52011'],
  ['info', 'POST /v1/chat/completions 200 · qwen3-8b-instruct · 1,284 tokens · 30.4s'],
  ['info', 'POST /v1/chat/completions 200 · gemma-3-12b · 412 tokens · 9.8s'],
  ['error', 'POST /v1/chat/completions 500 · model "llama-3.1-8b" is not loaded'],
]

/** Oldest first, as the log file has them. */
function logs(): LogEntry[] {
  const out: LogEntry[] = []
  let t = now - 2 * MIN
  for (let i = 0; i < 48; i++) {
    const [level, source, message] = LOG_BASE[(i * 7) % LOG_BASE.length]
    out.push({ timestamp: t, level, target: TARGET[source], message } as LogEntry)
    t -= (17 + ((i * 13) % 60)) * 1000
  }
  // Earlier in the day, so the activity chart has a shape.
  for (let h = 1; h < 24; h++) {
    const n = 3 + ((h * 7) % 9)
    for (let j = 0; j < n; j++) {
      const [level, source, message] = LOG_BASE[(h + j * 5) % LOG_BASE.length]
      out.push({ timestamp: now - h * 60 * MIN - j * 211_000, level, target: TARGET[source], message } as LogEntry)
    }
  }
  SERVER_LOG.forEach(([level, message], i) =>
    out.push({ timestamp: now - (40 - i * 6) * MIN, level, target: TARGET.proxy, message } as LogEntry)
  )
  return out.sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
}

/* ---------------- memory ---------------- */

const memory = (
  id: string,
  content: string,
  creator: string,
  useCount: number,
  lastUsedMin: number,
  pinned = false
) => ({
  id,
  content,
  preview: content,
  scope: 'user',
  creator,
  origin: creator === 'user' ? 'settings' : 'agent',
  sourceType: creator === 'user' ? 'user-authored' : 'extracted',
  status: 'active',
  pinned,
  redacted: false,
  createdAt: sec(new Date('2026-09-01T09:00:00').getTime()),
  updatedAt: sec(now - lastUsedMin * MIN),
  lastUsedAt: sec(now - lastUsedMin * MIN),
  useCount,
  expiresAt: null,
  category: null,
  projectId: null,
  sessionId: null,
  sourceSessionId: null,
  sourceMessageId: null,
  sourceDeleted: false,
  supersedes: null,
  version: 1,
})

const MEMORIES = [
  memory('m_12', 'Prefers terse replies and exact error strings.', 'user', 41, 30, true),
  memory('m_18', 'Works on Windows 11, runs go test with -count=1.', 'agent', 12, 1500),
  memory('m_03', 'Main project is acme-weather, a Go API with a TypeScript dashboard.', 'user', 88, 90),
]

/* ---------------- seed ---------------- */

function answers() {
  const at = 'plugin:agent-tools|'
  answer(`${at}memory_settings_get`, () => ({
    automaticallySave: false,
    recall: { session: true, project: true, user: true },
    memoryEnabled: true,
    schemaVersion: 1,
  }))
  answer(`${at}memory_storage_summary`, () => ({
    sessionCount: 0,
    projectCount: 6,
    userCount: 14,
    deletedCount: 0,
    conflictedCount: 2,
    bytes: 11_469,
    issues: [],
  }))
  answer(`${at}memory_records_list`, (a) => {
    const q = String(a.query ?? '').toLowerCase()
    const items = a.scope === 'user' ? MEMORIES.filter((m) => m.content.toLowerCase().includes(q)) : []
    return { items, total: a.scope === 'user' && !q ? 14 : items.length, offset: 0 }
  })
  answer(`${at}memory_conflicts`, () => [
    {
      subject: 'test flags',
      left: memory('m_31', 'Runs tests with -race.', 'agent', 3, 600),
      right: memory('m_32', 'Runs tests without -race.', 'agent', 1, 2000),
    },
  ])
  answer(`${at}memory_proposals_list`, () => [
    {
      id: 'p_1',
      content: 'acme-weather keys cached forecasts by UTC date.',
      scope: 'project',
      reason: 'automatic-saving-disabled',
      explanation: 'Automatic saving is off, so Flint asks before keeping this.',
      approvable: true,
      sourceSessionId: 'release',
      sourceMessageId: null,
      createdAt: sec(now - 12 * MIN),
    },
  ])
  answer(`${at}permission_audit_recent`, () =>
    [
      ['bash', 'Once', 'allow', 3],
      ['write_file', 'Conversation', 'granted', 13],
      ['git push', 'Once', 'deny', 46],
      ['web_fetch', 'Everywhere', 'granted', 92],
      [
        'bash',
        'Once',
        'allow',
        120,
        'gh pr create --title "fix(forecast): key the cache by UTC date" --body "Cached forecasts were keyed by local date, so a request just after midnight UTC returned yesterday\'s data. This keys them by UTC date and adds a regression test.\\n\\nTested: go test ./internal/cache/..."',
      ],
    ].map(([tool, reason, decision, ago, resource]) => ({
      v: 1,
      at: new Date(now - Number(ago) * MIN).toISOString(),
      session: 'release',
      run: 'r1',
      call: 'c1',
      agent: 'flint',
      project: 'acme-weather',
      tool,
      capability: tool,
      kind: 'tool',
      resource: resource ?? '',
      decision,
      reason,
      rule: '',
    }))
  )
  answer(`${at}access_list`, () => [
    {
      id: 'g1',
      session: 'release',
      path: 'C:\\Projects\\acme-weather',
      display: 'C:\\Projects\\acme-weather',
      isDir: true,
      mode: 'write',
      reason: 'Fix the forecast cache',
      grantedAt: sec(now - 20 * MIN),
      expiresAt: sec(new Date('2026-09-26T10:00:00').getTime()),
      persistent: false,
    },
  ])
  answer(`${at}memory_list`, () => ['build-notes'])
  answer(`${at}skill_list`, () => [{ name: 'go-testing', description: 'Run and read go tests' }])
  answer(`${at}sandbox_status`, () => ({ backend: 'appcontainer', enforces: true }))
  answer(`${at}workspace_path`, () => `${PREVIEW_DATA_FOLDER}\\agent`)
  const plugin = (id: string, version: string, description: string, repo: string, enabled: boolean) => ({
    id,
    name: id,
    description,
    version,
    repo,
    skills: 3,
    commands: 0,
    agents: 0,
    enabled,
    sourceKind: null,
    source: repo,
  })
  answer('agent_plugin_list', () => [
    plugin('flint-core', '1.4.0', 'Skills for Go, git and testing.', 'Local folder', true),
    plugin('release-kit', '0.3.2', 'Changelog and release-note helpers.', 'github.com/acme/release-kit', true),
    plugin('design-kit', '0.9.0', 'Frontend and artifact design skills.', 'Configured marketplace', false),
  ])
}

/** The engine extensions a desktop install lists; the browser loads none. */
function seedExtensions() {
  // The manager lives on window.core, set up when the app mounts; the seed
  // runs again after that.
  if (!(window as unknown as { core?: object }).core) return
  const manager = ExtensionManager.getInstance()
  if (manager.listExtensions().length > 0) return
  const list: [string, string, string, string][] = [
    ['@janhq/assistant-extension', 'Jan Assistant', '1.0.2', 'Powers the default AI assistant that works with all your installed models.'],
    ['@janhq/conversational-extension', 'Conversational', '1.0.0', 'Enables conversations and state persistence via your file system.'],
    ['@janhq/llamacpp-extension', 'llama.cpp Inference Engine', '1.0.1', 'This extension enables llama.cpp chat completion API calls'],
    ['@janhq/mlx-extension', 'MLX Inference Engine', '1.0.0', 'This extension enables MLX-Swift inference on Apple Silicon Macs'],
    ['@janhq/rag-extension', 'RAG Tools', '0.1.0', 'Registers RAG tools and orchestrates retrieval across parser, embeddings, and vector DB'],
    ['@janhq/vector-db-extension', 'Vector DB', '0.1.0', 'Vector DB integration using sqlite-vec if available with linear fallback'],
  ]
  for (const [name, productName, version, description] of list) {
    const rag = name === '@janhq/rag-extension'
    manager.register(name, {
      name,
      productName,
      version,
      description,
      // The RAG tools answer the Attachments page with their settings schema
      // (extensions/rag-extension/settings.json).
      type: () => (rag ? ExtensionTypeEnum.RAG : undefined),
      getSettings: rag ? async () => RAG_SETTINGS : undefined,
      onLoad: () => {},
      onUnload: () => {},
    } as never)
  }
  // A page that asked before the extensions existed asks again.
  void useAttachments.getState().loadSettingsDefs()
}

const num = (key: string, titleKey: string, descKey: string, value: number, min: number, max: number, step: number) => ({
  key,
  titleKey: `settings:attachments.${titleKey}`,
  descriptionKey: `settings:attachments.${descKey}`,
  controllerType: 'input',
  controllerProps: { value, type: 'number', min, max, step, textAlign: 'right' },
})
const RAG_SETTINGS = [
  { key: 'enabled', titleKey: 'settings:attachments.enable', descriptionKey: 'settings:attachments.enableDesc', controllerType: 'checkbox', controllerProps: { value: true } },
  {
    key: 'parse_mode',
    titleKey: 'settings:attachments.parseMode',
    descriptionKey: 'settings:attachments.parseModeDesc',
    controllerType: 'dropdown',
    controllerProps: {
      value: 'auto',
      options: [
        { name: 'Auto', value: 'auto' },
        { name: 'Include in chat', value: 'inline' },
        { name: 'Ingest as embeddings', value: 'embeddings' },
        { name: 'Ask every time', value: 'prompt' },
      ],
    },
  },
  num('auto_inline_context_ratio', 'autoInlineThreshold', 'autoInlineThresholdDesc', 0.75, 0.05, 1, 0.05),
  num('max_file_size_mb', 'maxFile', 'maxFileDesc', 100, 1, 200, 1),
  num('retrieval_limit', 'topK', 'topKDesc', 3, 1, 20, 1),
  num('retrieval_threshold', 'threshold', 'thresholdDesc', 0.3, 0, 1, 0.01),
  num('chunk_size_chars', 'chunkSize', 'chunkSizeDesc', 512, 64, 8192, 64),
  num('overlap_chars', 'chunkOverlap', 'chunkOverlapDesc', 64, 0, 1024, 16),
  {
    key: 'search_mode',
    titleKey: 'settings:attachments.searchMode',
    descriptionKey: 'settings:attachments.searchModeDesc',
    controllerType: 'dropdown',
    controllerProps: {
      value: 'auto',
      options: [
        { name: 'Auto (recommended)', value: 'auto' },
        { name: 'ANN (sqlite-vec)', value: 'ann' },
        { name: 'Linear', value: 'linear' },
      ],
    },
  },
]

function seedClaudeCode() {
  try {
    if (localStorage.getItem('claude-code-helper-models')) return
    localStorage.setItem(
      'claude-code-helper-models',
      JSON.stringify({
        big: 'claude-opus-5-5',
        medium: 'claude-sonnet-5',
        small: 'qwen3-8b-instruct',
        envVars: [
          { key: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:1337' },
          { key: 'ANTHROPIC_AUTH_TOKEN', value: 'preview' },
        ],
        customCli: 'claude',
      })
    )
  } catch {
    // Storage unavailable: the page shows its empty selectors.
  }
}

type Hub = Record<string, Record<string, unknown>>

/** Service answers; called on every pass because the hub can be replaced. */
export function patchSettingsServices(hub: Hub) {
  const set = (service: string, method: string, fn: (...a: never[]) => unknown) => {
    const target = hub[service]
    if (target) target[method] = fn
  }
  set('appService', 'getJanDataFolder', async () => PREVIEW_DATA_FOLDER)
  set('appService', 'readLogs', async () => logs())
  set('appService', 'getServerStatus', async () => true)
  set('hardwareService', 'getHardwareInfo', async () => HARDWARE)
  set('hardwareService', 'getSystemUsage', async () => usage())
  set('hardwareService', 'getLlamacppDevices', async () => [
    { id: 'CUDA0', name: 'NVIDIA GeForce RTX 4060', mem: 8 * GB, free: 1.4 * GB, activated: true },
    { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 4060', mem: 8 * GB, free: 1.4 * GB, activated: true },
    { id: 'Vulkan1', name: 'AMD Radeon Graphics (iGPU)', mem: 2 * GB, free: 1.8 * GB, activated: false },
  ])
  set('mcpService', 'trustReport', async () => ({
    trusted: [
      { name: 'filesystem', fingerprint: 'fp-fs', grantedAt: new Date(now - 3 * 86_400_000).toISOString(), currentFingerprint: 'fp-fs' },
      { name: 'github', fingerprint: 'fp-gh-old', grantedAt: new Date(now - 9 * 86_400_000).toISOString(), currentFingerprint: 'fp-gh' },
    ],
    invalidated: [
      { name: 'playwright', reason: 'configuration-changed', at: new Date(now - 86_400_000).toISOString(), fingerprint: 'fp-pw' },
    ],
  }))
  set('mcpService', 'serverFingerprints', async () => ({ filesystem: 'fp-fs', github: 'fp-gh', playwright: 'fp-pw2' }))
}

export function seedSettingsPreview() {
  installPreviewTauri()
  answers()
  seedExtensions()
  seedClaudeCode()
  useHardware.setState({ hardwareData: HARDWARE, systemUsage: usage() } as never)
  useAppState.setState({ serverStatus: 'running' } as never)
  if (!useLocalApiServer.getState().defaultModelLocalApiServer)
    useLocalApiServer.setState({
      defaultModelLocalApiServer: { model: 'qwen3-8b-instruct', provider: 'llamacpp' },
    } as never)
  useToolApproval.setState({
    approvedTools: { release: ['bash', 'create_pull_request'] },
    approvedToolsGlobal: ['read_file', 'web_fetch'],
    allowAllMCPPermissions: false,
  } as never)
  const assistants = useAssistant.getState().assistants
  if (!assistants.some((a) => a.id === 'rust-reviewer')) {
    useAssistant.setState({
      assistants: [
        ...assistants,
        { id: 'rust-reviewer', avatar: '🦀', name: 'Rust reviewer', description: 'Reviews Rust diffs for correctness and idiom.', instructions: '', parameters: {}, created_at: now },
        { id: 'changelog', avatar: '✍️', name: 'Changelog writer', description: 'Turns commit lists into short release notes.', instructions: '', parameters: {}, created_at: now },
      ],
    } as never)
  }
}
