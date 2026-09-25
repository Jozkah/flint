/**
 * Development-only preview data for looking at the interface in a plain
 * browser (`yarn dev:web`, then open any page with `?preview`). Outside Tauri
 * there are no providers, chats or sessions, and the first-run setup screen
 * covers the chat pages; this fills the stores with the same example content
 * the design mockup used, so pages can be compared screen for screen.
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
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import { useCoworkView } from '@/hooks/useCoworkView'
import { useUsageStats, dayKey } from '@/stores/usage-stats-store'
import { useServiceStore } from '@/hooks/useServiceHub'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useAssistant } from '@/hooks/useAssistant'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import { seedRooms } from './previewRooms'
import { seedEngine } from './previewSeedEngine'

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
        model('Qwen3-14B-Q4_K_M', 'Qwen3 14B', ['tools', 'reasoning']),
        model('gemma-3-12b-it-Q5_K_M', 'Gemma 3 12B', ['tools', 'vision']),
        model('Llama-4-Scout-17B-Q3_K_M', 'Llama 4 Scout', ['tools', 'vision']),
        model('Mistral-Small-3.2-24B-Q4_K_S', 'Mistral Small 3.2', ['tools']),
        model('jan-nano-4b-Q8_0', 'Jan Nano 4B', ['tools']),
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

const FOLDERS = [
  { id: 'flint', name: 'Jan / Flint', updated_at: now, assistantId: 'jan' },
  { id: 're', name: 'RE research', updated_at: now - 60 * MIN },
  { id: 'energy', name: 'Energy monitoring', updated_at: now - 300 * MIN },
]

/** The mockup's assistants: Flint, and two the user made. */
function assistants(): Assistant[] {
  const flint = useAssistant.getState().assistants.find((a) => a.id === 'jan')
  const base = { created_at: now / 1000, description: '', instructions: '', parameters: {} }
  return [
    ...(flint ? [flint] : []),
    { ...base, id: 'rust-reviewer', name: 'Rust reviewer', avatar: '🦀' },
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
  ['release', 'Release build fix', 2, 'flint', true],
  ['kravio', 'Kravio style preview', 20, undefined, true],
  ['escape', 'JSON escape tracking', 90, 'flint'],
  ['pr418', 'main | issue #412 | PR #418', 240, 'flint'],
  ['toolargs', 'Tool-call argument recovery', 30, 'flint'],
  ['sandbox', 'Windows sandbox failures', 1500, 'flint'],
  ['draft', 'Draggable conversation panes', 2900, 'flint'],
  ['notes', 'RE notes cleanup', 600, 're'],
  ['offsets', 'Offset table v3', 4000, 're'],
  ['provider', 'Provider adapter refactor', 45, 'energy'],
  ['trip', 'Weekend trip ideas', 6000],
  ['cmdwin', 'CMD windows opening for bash commands', 8000],
  ['vllm', 'vLLM Qwen3-Next-80B configuration', 9000],
  ['clutter', 'Windows PC clutter audit', 12000],
  ['test', 'Test', 20000],
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
      content: [text('The release build fails on Windows with exit 101. Can you find out why and fix it?')],
    },
    {
      ...base,
      id: 'm2',
      role: 'assistant',
      created_at: t(2),
      completed_at: t(2),
      metadata: {
        tokenSpeed: { tokenSpeed: 42.3, tokenCount: 1284, durationMs: 30350 },
        model: { id: 'claude-sonnet-5', provider: 'anthropic' },
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
            projectId: 'jan-project:flint',
            projectName: 'Jan / Flint',
            disabled: false,
            temporary: false,
            unavailable: false,
          },
          tools: ['bash', 'read_file', 'grep', 'web_search', 'edit_file'],
          attachments: { inline: [], availableViaSearch: [] },
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          sendState: 'response-started',
          usageReported: true,
        },
      },
      content: [
        { type: 'reasoning', text: { value: "The tests spawn a helper binary. If nothing builds it first, every bash test fails before it starts. I'll check where it is built.", annotations: [] } },
        tool('read', 'c1', { path: 'src-tauri/Cargo.toml' }, '48 lines · [workspace] members = ["sandbox-helper", …]'),
        tool('grep', 'c2', { pattern: 'jan-sandbox-helper', path: 'src-tauri' }, 'src-tauri/Cargo.toml:4:    "sandbox-helper",\nsrc-tauri/sandbox-helper/Cargo.toml:2:name = "jan-sandbox-helper"\nsrc-tauri/src/agent_tools/bash.rs:31:const HELPER: &str = "jan-sandbox-helper";\nsrc-tauri/src/agent_tools/bash.rs:212:        .expect("helper not found: jan-sandbox-helper");\nsrc-tauri/src/agent_tools/sandbox.rs:18:/// Spawns jan-sandbox-helper with the job token.\nsrc-tauri/src/agent_tools/sandbox.rs:44:    let exe = helper_path("jan-sandbox-helper")?;\nsrc-tauri/src/agent_tools/sandbox.rs:97:// jan-sandbox-helper exits 3 when the token is stale\nsrc-tauri/tauri.conf.json:58:      "jan-sandbox-helper"\nsrc-tauri/build.rs:12:    // helper is built separately\nsrc-tauri/Makefile:21:\tcargo build -p jan-sandbox-helper\nsrc-tauri/README.md:40:`jan-sandbox-helper` must sit next to the app binary.\nsrc-tauri/sandbox-helper/src/main.rs:1://! jan-sandbox-helper: runs one command in the job object.'),
        tool('web_search', 'c3', { query: 'cargo test exit code 101 windows', top: 4 }, JSON.stringify([
          { title: "cargo test: process didn't exit successfully (exit code: 101)", url: 'https://doc.rust-lang.org' },
          { title: "Integration tests can't find binary built by another crate", url: 'https://github.com' },
        ])),
        tool('bash', 'c4', { command: 'cargo test --lib agent_tools::bash', cwd: 'src-tauri' },
          `${g('   Compiling')} app_lib v0.9.0 (C:\\Coding\\jan\\src-tauri)\n${g('    Finished')} \`test\` profile [unoptimized + debuginfo] target(s) in 38.21s\n\nrunning 5 tests\ntest agent_tools::bash::runs_echo ... ${r('FAILED')}\ntest agent_tools::bash::respects_cwd ... ${r('FAILED')}\ntest agent_tools::bash::times_out ... ${g('ok')}\ntest agent_tools::bash::streams_stderr ... ${r('FAILED')}\ntest agent_tools::bash::kills_tree ... ${r('FAILED')}\n\n${y('helper not found: target\\debug\\jan-sandbox-helper.exe')}\n\ntest result: ${r('FAILED')}. 1 passed; 4 failed; 0 ignored; finished in 0.84s\n[exit 101]`),
        { type: 'reasoning', text: { value: "Confirmed. I'll make build.rs build the helper.", annotations: [] } },
        tool('edit', 'c5', {
          path: 'src-tauri/build.rs',
          old_string: '    // helper is built separately',
          new_string: '    // Build the sandbox helper so tests can spawn it.\n    let status = std::process::Command::new("cargo")\n        .args(["build", "-p", "jan-sandbox-helper"])\n        .status().expect("failed to build jan-sandbox-helper");\n    assert!(status.success());',
        }, 'Edited src-tauri/build.rs (+6 −1)'),
        tool('bash', 'c6', { command: 'cargo test --lib agent_tools::bash', cwd: 'src-tauri' },
          `${g('   Compiling')} jan-sandbox-helper v0.9.0\n${g('    Finished')} \`test\` profile in 44.87s\n\nrunning 5 tests\ntest agent_tools::bash::runs_echo ... ${g('ok')}\ntest agent_tools::bash::respects_cwd ... ${g('ok')}\ntest agent_tools::bash::times_out ... ${g('ok')}\ntest agent_tools::bash::streams_stderr ... ${g('ok')}\ntest agent_tools::bash::kills_tree ... ${g('ok')}\n\ntest result: ${g('ok')}. 5 passed; 0 failed; 0 ignored; finished in 1.12s\n[exit 0]`),
        tool('bash', 'c7', { command: 'git status --short && git diff --stat' },
          `${r(' M')} src-tauri/build.rs\n${r('??')} src-tauri/tests/helper_smoke.rs\n src-tauri/build.rs | 7 ${g('++++++')}${r('-')}\n 1 file changed, ${g('6 insertions(+)')}, ${r('1 deletion(-)')}\n[exit 0]`),
        { type: 'tool_call', tool_name: 'bash', tool_call_id: 'c8', input: { command: 'git commit -am "fix(build): build sandbox helper before tests"' } },
        text('Fixed. `build.rs` now builds `jan-sandbox-helper` before the tests run, and all 5 bash tests pass. I also added a smoke test so a missing helper fails with a clear message instead of exit 101.'),
      ],
    },
  ] as unknown as ThreadMessage[]
}

/** How long each example call took, and the one still waiting for an answer. */
function seedToolRuntime() {
  const secs: Record<string, number> = { c1: 0.1, c2: 0.3, c3: 1.8, c4: 38.2, c5: 0.2, c6: 44.9, c7: 0.4 }
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
        '    10 |     tauri_build::build();',
        '-   11 |     // helper is built separately',
        '+   11 |     // Build the sandbox helper so tests can spawn it.',
        '+   12 |     let status = std::process::Command::new("cargo")',
        '+   13 |         .args(["build", "-p", "jan-sandbox-helper"])',
        '+   14 |         .status().expect("failed to build jan-sandbox-helper");',
        '+   15 |     assert!(status.success());',
        '    16 | }',
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
          input: { command: 'git commit -am "fix(build): build sandbox helper before tests"' },
          taskContext: 'Commit the build fix and the new smoke test.',
          workspaceLabel: 'C:\\Coding\\jan',
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
      act(20, 'tool-approved' as never, 'Tool call approved', 'Ran cargo build -j 4 in jan'),
      act(25, 'run-finished' as never, 'Assistant created', 'Release Captain with 6 tools'),
      act(40, 'model-swapped' as never, 'Model swapped', 'Chat moved to Qwen3 14B'),
      act(55, 'warning' as never, 'VRAM pressure', '11.4 / 12 GB used during load'),
      act(70, 'knowledge' as never, 'Knowledge indexed', 'Added 214 files from jan/web-app'),
      act(70, 'compaction' as never, 'Context compacted', 'Release build fix went from 31.2k to 6.4k tokens'),
    ],
  })
}

const JAN = 'C:\\Users\\Jozkah\\Desktop\\Coding\\jan'
const WORKTREE = `${JAN}\\.flint\\worktrees\\fix-json-escape`

/** A write/edit diff in the agent's own format: `±  line | text`. */
const diffOf = (hunks: [number, string][]) =>
  hunks.map(([n, l]) => `${l[0]} ${String(n).padStart(4)} | ${l.slice(1)}`).join('\n')

/** The mockup's example session: plan, tool activity, a question, changes. */
function escapeSession() {
  const at = (m: number) => now - m * MIN
  const turns = [
    {
      role: 'user',
      content: 'Windows paths in tool arguments still break JSON parsing. Fix the escape tracking and add tests for UNC paths.',
      startedAt: at(8),
    },
    {
      role: 'assistant',
      content: '',
      startedAt: at(8),
      asks: [
        {
          requestId: 'ask-unc',
          sessionId: 'escape',
          at: new Date(at(1)).toISOString(),
          state: 'pending',
          request: {
            questions: [
              {
                id: 'where',
                question: 'Where should the new UNC path tests live?',
                recommended: 0,
                options: [
                  { label: 'In the existing recover.rs test module', description: 'Keeps all recovery tests together.' },
                  { label: 'In a new windows_paths.rs file', description: 'Clearer if more Windows cases follow.' },
                  { label: 'Only as doc tests', description: 'Lightest, but harder to run alone.' },
                ],
              },
              {
                id: 'long',
                question: 'Cover long-path (\\\\?\\) prefixes too?',
                options: [{ label: 'Yes' }, { label: 'No, UNC only' }],
              },
            ],
          },
        },
      ],
    },
    {
      role: 'tool',
      name: 'read',
      callId: 'e1',
      args: { path: 'src/agent/json_recovery.rs' },
      result: '212 lines',
      toolState: 'succeeded',
      status: 'done',
      startedAt: at(7.9),
      endedAt: at(7.9) + 100,
    },
    {
      role: 'tool',
      name: 'bash',
      callId: 'e2',
      args: { command: 'cargo test recover_args' },
      result: `test recover_args::windows_path ... ${r('FAILED')}\n${y('assertion failed: escaped == raw')}\n  left: "C:\\\\Users\\\\jozkah"\n right: "C:\\\\\\\\Users\\\\\\\\jozkah"`,
      isError: true,
      exitCode: 101,
      toolState: 'failed',
      status: 'done',
      startedAt: at(7.5),
      endedAt: at(7.5) + 12_000,
    },
    {
      role: 'tool',
      name: 'edit',
      callId: 'e3',
      args: { path: 'src/agent/json_recovery.rs' },
      argsLive: '{"path":"src/agent/json_recovery.rs"',
      toolState: 'running',
      status: 'running',
      startedAt: at(0.2),
    },
  ]
  // What the test-writer subagent changed, so the Changes panel has files.
  const subTurn = (callId: string, name: 'write' | 'edit', path: string, diff: string) => ({
    role: 'tool',
    name,
    callId,
    args: { path },
    result: `Edited ${path}`,
    diff,
    toolState: 'succeeded',
    status: 'done',
  })
  const subagents = [
    {
      runId: 'sa-writer',
      name: 'test-writer',
      status: 'done',
      startedAt: at(6),
      endedAt: at(5),
      turns: [
        subTurn('s1', 'edit', 'src-tauri/src/agent/json_recovery.rs', [
          '@@ edit 1/1 @@',
          diffOf([
            [58, "-            '\\\\' => escaped = true,"],
            [58, "+            '\\\\' if in_str => {"],
            [59, '+                // Windows paths: keep a lone backslash literal'],
            [60, '+                escaped = !is_path_char(next);'],
            [61, '+            }'],
            [74, '+fn is_path_char(c: Option<char>) -> bool {'],
            [75, "+    matches!(c, Some(c) if c.is_ascii_alphanumeric() || c == '.' || c == ' ')"],
            [76, '+}'],
          ]),
        ].join('\n')),
        subTurn('s2', 'write', 'src-tauri/src/agent/tests/recover.rs', diffOf([
          [1, '+use crate::agent::json_recovery::recover_args;'],
          [2, '+'],
          [3, '+#[test]'],
          [4, '+fn unc_path_survives() {'],
          [5, '+    let raw = r#"{"path":"\\\\server\\share\\file.txt"}"#;'],
          [6, '+    assert_eq!(recover_args(raw).unwrap()["path"], "\\\\server\\share\\file.txt");'],
          [7, '+}'],
        ])),
        subTurn('s3', 'edit', 'src-tauri/src/agent/mcp_args.rs', [
          '@@ edit 1/1 @@',
          diffOf([
            [31, '-    let value = serde_json::from_str(raw)?;'],
            [31, '+    let value = recover_args(raw)'],
            [32, '+        .or_else(|_| serde_json::from_str(raw))?;'],
          ]),
        ].join('\n')),
      ],
    },
  ]
  return {
    id: 'escape',
    title: 'Fix JSON escape tracking',
    folder: JAN,
    mode: 'ask',
    access: 'managed-worktree',
    turns,
    subagents,
    todos: {
      phases: [
        {
          name: 'Fix',
          tasks: [
            { content: 'Read the tool-arg recovery code', status: 'completed' },
            { content: 'Reproduce the bad escape with a failing test', status: 'completed' },
            { content: 'Patch the escape state machine', status: 'in_progress' },
            { content: 'Run the full test suite', status: 'pending' },
          ],
        },
      ],
    },
    messages: [],
    updated: at(1),
    model: { provider: 'anthropic', id: 'claude-sonnet-5' },
  }
}

/** The background work the mockup's workflow card and Activity panel show. */
function seedActivity() {
  const at = (m: number) => now - m * MIN
  const task = (
    id: string,
    workflowId: string,
    kind: 'agent' | 'shell',
    title: string,
    status: string,
    startedAt: number,
    extra: Record<string, unknown> = {}
  ) => [id, { id, callId: id, sessionId: 'escape', workflowId, kind, title, status, startedAt, ...extra }]
  const tasks = Object.fromEntries([
    task('t1', 'w1', 'agent', 'Audit escape handling', 'done', at(7), {
      endedAt: at(7) + 41_000, agentName: 'auditor', model: 'claude-sonnet-5', usage: { total_tokens: 6_200 }, toolCount: 9,
    }),
    task('t2', 'w1', 'shell', 'cargo test recover_args', 'error', at(6.5), {
      endedAt: at(6.5) + 12_000, command: 'cargo test recover_args', exitCode: 101,
    }),
    task('t3', 'w1', 'agent', 'Write UNC path cases', 'running', now - 18_000, {
      agentName: 'test-writer', model: 'claude-sonnet-5', usage: { total_tokens: 3_100 }, toolCount: 4,
    }),
    task('t4', 'w1', 'shell', 'cargo test --workspace', 'queued', now - 5_000, {
      command: 'cargo test --workspace', waiting: 1,
    }),
    task('t5', 'w2', 'shell', 'cargo check -p app_lib', 'done', at(12), {
      endedAt: at(12) + 38_000, command: 'cargo check -p app_lib', exitCode: 0,
    }),
    task('t6', 'w2', 'agent', 'Summarise failures', 'cancelled', at(11), {
      endedAt: at(11) + 4_000, agentName: 'summariser', detail: 'Stopped by you',
    }),
  ])
  useCoworkActivity.setState({
    workflows: {
      w1: {
        id: 'w1', sessionId: 'escape', title: 'Verify recovery across platforms', startedAt: at(7),
        phases: [], anchorMessageId: 'escape-asst-1', model: 'claude-sonnet-5',
      },
      w2: { id: 'w2', sessionId: 'escape', title: 'Check the build', startedAt: at(12), endedAt: at(11), phases: [] },
    },
    tasks,
  } as never)
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
    model: { provider: 'anthropic', id: 'claude-sonnet-5' },
  })
  const sessions = [
    escapeSession(),
    session('changelog', 'Draft 0.9.0 changelog', 50, JAN),
    session('paths', 'Heal Windows paths', 400, JAN),
    session('sync', 'Sync RE findings', 3000, null),
  ]
  useCoworkSessions.setState({ sessions: sessions as never, currentId: 'escape' } as never)
  useCoworkRun.setState({ runs: { escape: { startedAt: now } } } as never)
  seedActivity()
  // The session works in a managed worktree, as the mockup's does. The web
  // build cannot ask the backend what it can confine, so the answer is given
  // here -- and given again when the page's own query fails.
  useCoworkWorktrees.setState({
    bySession: {
      escape: {
        path: WORKTREE,
        branch: 'flint/fix-json-escape',
        baseSha: 'ca08fc9',
        sourceRoot: JAN,
        identity: {} as never,
        uncommittedAtCreation: [],
      },
    },
  } as never)
  const grant = () =>
    useDirectEditGrants.setState({
      capability: { known: true, directEdit: false, managedWorktree: true },
      bySession: { escape: { sessionId: 'escape', folder: WORKTREE, grantId: 'preview' } },
    } as never)
  grant()
  useDirectEditGrants.subscribe((s) => {
    if (!s.capability.known) grant()
  })
  // The Output panel open on Changes, as the mockup shows it.
  useCoworkView.getState().setRail('escape', { kind: 'diff' })
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
}

/** Read by hooks that would otherwise ask the backend (dev builds only). */
function seedBackendAnswers() {
  const w = window as unknown as { __flintPreview?: object }
  w.__flintPreview = {
    memoryProposals: [
      {
        id: 'prop-1',
        content: 'This project builds jan-sandbox-helper before running agent tool tests.',
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
    selectedProvider: 'anthropic',
    selectedModel: model('claude-sonnet-5', 'Claude Sonnet 5', ['tools', 'vision', 'reasoning']),
  } as never)
  useThreads.getState().setThreads(threads())
  useThreads.setState({ isLoadingThreads: false } as never)
  useMessages.getState().setMessages('release', releaseMessages())
  useAppState.setState({
    activeModels: ['Qwen3-14B-Q4_K_M', 'claude-sonnet-5', 'gpt-5-mini'],
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
  // Folders live in a store the hook reads through the projects service; the
  // hook's own setter is reached from its module.
  void import('@/hooks/useThreadManagement').then((m) => {
    const store = (m as unknown as { useThreadManagementStore?: { setState: (s: object) => void } }).useThreadManagementStore
    store?.setState({ folders: FOLDERS })
  })
  try {
    localStorage.setItem('setup-completed', 'true')
    localStorage.setItem('recent-searches', JSON.stringify(['release', 'kravio', 'escape', 'pr418']))
  } catch {
    // Storage may be unavailable; the providers alone pass the setup gate.
  }
}
