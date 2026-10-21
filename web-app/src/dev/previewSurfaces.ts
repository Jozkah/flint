/**
 * Development-only: example content for surfaces that need a backend or a
 * particular run to show anything, so they can be looked at in a plain browser.
 *
 * Always on (small, read-only answers): the archive, remote access, usage
 * attribution, policy rule warnings and hooks cards.
 *
 * Behind a switch, because they change what the Cowork page shows:
 *   ?workflow   a workflow card with phases under the running session's prompt
 *   ?held       input a failed run did not take, and mail from another session
 *   ?elicit     an MCP server's question card (`?elicit=url` for the link form)
 *   ?setup      the first-run setup wizard (no `setup-completed` flag)
 */
import { answer } from '@/dev/previewTauri'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { useMcpElicitationStore } from '@/hooks/useMcpElicitation'
import { useMessageQueue } from '@/stores/message-queue-store'
import { taskIdFor } from '@/lib/coworkActivity'

const MIN = 60_000

/** Answers for `lib/previewInvoke` commands (see previewSeedEngine's previewInvoke). */
export function surfaceInvoke(
  command: string,
  args?: Record<string, unknown>
): Promise<unknown> | undefined {
  const ok = (v: unknown) => Promise.resolve(v)
  switch (command) {
    case 'agent_policy_rule_warnings':
      return ok([
        {
          project: 'acme-weather',
          folder: 'C:\\Users\\dev\\projects\\acme-weather',
          warnings: [
            {
              list: 'deny',
              rule: 'bash(rm -rf *',
              kind: 'malformed',
              reason: 'The closing parenthesis is missing, so this rule was dropped and nothing is denied.',
            },
            {
              list: 'ask',
              rule: 'Bash(git psh *)',
              kind: 'unknown-tool',
              reason: 'No tool is called "git psh"; the rule never matches.',
            },
            {
              list: 'allow',
              rule: 'read(**)',
              kind: 'unsafe-wildcard',
              reason: 'This allows every file, including ones outside the project.',
            },
          ],
        },
      ])
    case 'folder_trust_list':
      return ok(['C:\\Users\\dev\\projects\\acme-weather'])
    case 'agent_hooks_report':
      return ok({
        source: `${String(args?.folder ?? '')}\\.flint\\hooks.toml`,
        exists: true,
        trusted: true,
        error: null,
        declared: 3,
        hooks: [
          {
            event: 'pre_tool_use',
            command: 'node scripts/check-secrets.mjs',
            onFailure: 'block',
            timeoutSecs: 10,
            tools: ['write', 'edit'],
            stdinJson: true,
            if: null,
            jsonOutput: true,
          },
          {
            event: 'post_tool_use',
            command: 'gofmt -l .',
            onFailure: 'warn',
            timeoutSecs: 20,
            tools: ['edit'],
            stdinJson: false,
            if: 'path:*.go',
            jsonOutput: false,
          },
          {
            event: 'session_end',
            command: 'git status --short',
            onFailure: 'ignore',
            timeoutSecs: 5,
            tools: [],
            stdinJson: false,
            if: null,
            jsonOutput: false,
          },
        ],
      })
    default:
      return undefined
  }
}

const ARCHIVED = [
  ['thread', 'a1', 'Draft the migration plan', 3],
  ['cowork', 'a2', 'Fix the flaky radar test', 9],
  ['room', 'a3', 'Which model explains it best?', 20],
] as const

/** Tauri-bridge answers (`window.__TAURI_INTERNALS__`), the same way previewStudio does. */
function answerCommands() {
  answer('get_usage_attribution', () => ({
    since: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    skills: [
      { name: 'release-notes', calls: 14, resultTokens: 5200 },
      { name: 'go-test', calls: 9, resultTokens: 3100 },
    ],
    mcpServers: [
      { name: 'github', calls: 41, resultTokens: 18_700 },
      { name: 'filesystem', calls: 23, resultTokens: 7400 },
    ],
    plugins: [{ name: 'flint-core', calls: 6, resultTokens: 1900 }],
    subagents: [
      { name: 'explorer', calls: 12, resultTokens: 9800, inputTokens: 41_000, outputTokens: 6200 },
      { name: 'reviewer', calls: 4, resultTokens: 2600, inputTokens: 12_400, outputTokens: 1900 },
    ],
    unused: [
      { kind: 'skill', name: 'api-docs', contextTokens: 640 },
      { kind: 'mcp', name: 'you-search', contextTokens: 2100 },
      { kind: 'subagent', name: 'translator' },
    ],
  }))
  answer('archive_list', () =>
    ARCHIVED.map(([kind, id, title, hours], i) => ({
      archiveId: `arch-${id}`,
      kind,
      id,
      title,
      archivedAt: Date.now() - hours * 3_600_000,
      origin: 'delete',
      storage: 'payload',
      sizeBytes: 18_000 + i * 41_000,
    }))
  )
  answer('archive_disk_usage', () => ARCHIVED.reduce((n, _, i) => n + 18_000 + i * 41_000, 0))
  answer('archive_get_settings', () => ({ enabled: true, autoDeleteDays: 30, autoArchiveThreadDays: 0 }))
  answer('archive_preview', (a) => ({
    kind: 'thread',
    title: String(a.archiveId ?? 'Archived item'),
    participants: [],
    messages: [
      { role: 'user', text: 'Draft the migration plan for the settings pages.' },
      { role: 'assistant', text: 'Here is a plan in three steps: inventory, move, verify.' },
    ],
    totalMessages: 2,
    threads: [],
    fields: [],
  }))
  answer('remote_get_status', () => ({
    config: {
      enabled: true,
      interface: 'lan',
      port: 8787,
      certPath: null,
      keyPath: null,
      allowApprovals: true,
      allowAlwaysAllow: false,
      maxUploadMb: 50,
      allowPreviewProxy: false,
    },
    running: true,
    serving: {
      address: '192.168.1.24:8787',
      host: '192.168.1.24',
      port: 8787,
      https: true,
      tlsSource: 'self_signed',
      fingerprint: 'AB:12:9F:3C:7D:44:E0:19',
      baseUrl: 'https://192.168.1.24:8787',
    },
    error: null,
    detected: { tailscale: null, lan: '192.168.1.24' },
    pairedDevices: 2,
    connectedDevices: 1,
    phoneApp: true,
  }))
  answer('remote_list_devices', () => [
    { id: 'd1', name: 'Pixel 9', pairedAt: Date.now() - 5 * 86_400_000, lastSeen: Date.now() - 2 * MIN, connected: true },
    { id: 'd2', name: 'iPhone 15', pairedAt: Date.now() - 20 * 86_400_000, lastSeen: Date.now() - 3 * 86_400_000, connected: false },
  ])
}

function seedWorkflow() {
  const sessionId = 'escape'
  const workflowId = 'wf-preview'
  const at = Date.now()
  const phases = [
    { id: `${workflowId}:p0`, name: 'Investigate', index: 0 },
    { id: `${workflowId}:p1`, name: 'Implement', index: 1 },
    { id: `${workflowId}:p2`, name: 'Verify', index: 2 },
  ]
  const task = (
    callId: string,
    title: string,
    phase: number,
    status: 'done' | 'running' | 'queued' | 'error',
    extra: Record<string, unknown> = {}
  ) => {
    const id = taskIdFor(sessionId, workflowId, callId)
    return [
      id,
      {
        id,
        callId,
        sessionId,
        workflowId,
        phaseId: phases[phase].id,
        phase: { name: phases[phase].name, index: phase },
        kind: 'agent',
        title,
        agentName: title,
        description: `${title} for the radar retry`,
        status,
        startedAt: at - (9 - phase * 2) * MIN,
        endedAt: status === 'done' || status === 'error' ? at - (7 - phase * 2) * MIN : undefined,
        model: 'qwen3-8b-instruct',
        background: true,
        toolCount: 6,
        ...extra,
      },
    ] as const
  }
  const tasks = Object.fromEntries([
    task('w1', 'explorer', 0, 'done'),
    task('w2', 'api-reader', 0, 'done'),
    task('w3', 'implementer', 1, 'running'),
    task('w4', 'test-writer', 1, 'running'),
    task('w5', 'reviewer', 2, 'queued', { waiting: 1 }),
    task('w6', 'linter', 2, 'error', { detail: 'The agent hit its step limit before it finished.', stoppedAtLimit: true }),
  ])
  useCoworkActivity.setState({
    workflows: {
      [workflowId]: {
        id: workflowId,
        sessionId,
        title: 'Review and ship the radar retry',
        startedAt: at - 10 * MIN,
        phases,
        anchorMessageId: 'escape-asst-1',
        model: 'qwen3-8b-instruct',
      },
    },
    tasks,
  } as never)
}

function seedHeld() {
  const at = Date.now()
  useMessageQueue.setState((s: { queues: Record<string, unknown[]> }) => ({
    queues: {
      ...s.queues,
      escape: [
        { id: 'h1', text: 'Also cap the backoff at 2 seconds.', createdAt: at - 40_000, held: true },
        { id: 'h2', text: 'Then update the README section on radar caching.', createdAt: at - 30_000, held: true },
        {
          id: 'h3',
          text: 'Heads up: the forecast cache tests now pin the clock, so rebase before you push.',
          createdAt: at - 20_000,
          held: true,
          steer: true,
          from: { sessionId: 'dash', displayName: 'Hourly chart tooltip', messageId: 'm-77', depth: 1 },
        },
      ],
    },
  }) as never)
}

function seedElicit(kind: string | null) {
  const store = useMcpElicitationStore.getState()
  if (kind === 'url') {
    store.push({
      mode: 'url',
      id: 'elicit-url',
      server: 'github',
      message: 'Sign in to GitHub to let this server open pull requests for you.',
      url: 'https://github.com/login/device',
      host: 'github.com',
    })
    return
  }
  store.push({
    mode: 'form',
    id: 'elicit-form',
    server: 'filesystem',
    message: 'The server needs a few details before it can index this folder.',
    fields: [
      { name: 'path', title: 'Folder', description: 'Where the project lives.', kind: 'string', required: true, secret: false, options: [] },
      { name: 'token', title: 'Access token', kind: 'string', required: false, secret: true, options: [] },
      {
        name: 'depth',
        title: 'Depth',
        kind: 'choice',
        required: true,
        secret: false,
        options: [
          { value: 'shallow', label: 'Top level only' },
          { value: 'deep', label: 'Every subfolder' },
        ],
      },
      { name: 'watch', title: 'Watch for changes', kind: 'boolean', required: false, secret: false, default: true, options: [] },
    ],
  })
}

let answered = false
/** Called by `seedPreview` (and again after start-up hydration; idempotent). */
export function seedSurfaces(p: URLSearchParams) {
  if (!answered) {
    answered = true
    answerCommands()
  }
  if (p.has('workflow')) seedWorkflow()
  if (p.has('held')) seedHeld()
  if (p.has('elicit') && useMcpElicitationStore.getState().queue.length === 0) seedElicit(p.get('elicit'))
}
