/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

/**
 * janhq/jan#8905: two Cowork sessions, driven through the real route.
 *
 * Each run is held open until the test settles it, so what these tests check
 * is exactly the window the defect lived in: a session switch between a run
 * starting and it reporting back. Everything below the route is real except
 * the boundary -- Tauri, the model stream -- as in `cowork.route.test.tsx`.
 */

type HeldRun = {
  sid: string
  opts: any
  resolve: (outcome: any) => void
}

const h = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  executeAgentTool: vi.fn(async (..._args: any[]) => ({ content: 'ok' })),
  runs: [] as HeldRun[],
  transports: [] as { sessionId: string; config: any }[],
  picker: null as any,
  text: 'do the thing',
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
  models: {
    selectedProvider: 'llamacpp',
    selectedModel: {
      id: 'model-a',
      capabilities: ['tools'],
      settings: { ctx_len: { controller_props: { value: 8192 } } },
    } as any,
    providers: [
      {
        provider: 'llamacpp',
        active: true,
        models: [
          { id: 'model-a', capabilities: ['tools'] },
          { id: 'model-b', capabilities: ['tools'] },
        ],
      },
    ] as any[],
    selectModelProvider: vi.fn(),
    getProviderByName: (name: string) =>
      h.models.providers.find((p: any) => p.provider === name),
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({ ...config, id: '/cowork' }),
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
  Link: (props: any) => <a {...props} />,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('sonner', () => ({ toast: h.toast }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
vi.mock('@janhq/tauri-plugin-agent-tools-api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  directEditCapability: vi.fn(async () => true),
  directEditAuthorize: vi.fn(async () => 'grant-1'),
  directEditRevoke: vi.fn(async () => true),
  directEditRevokeSession: vi.fn(async () => true),
  projectListDir: vi.fn(async () => []),
  projectReadFile: vi.fn(async () => ''),
  bashJobsList: vi.fn(async () => []),
}))
vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  getLoadedModels: vi.fn(async () => ['model-a', 'model-b']),
}))
vi.mock('@/lib/agentTools', () => ({
  executeAgentTool: h.executeAgentTool,
  // Main's approval prompt asks for the diff first (AH-146); the real one
  // never throws and resolves to nothing when there is no diff.
  previewAgentChange: vi.fn(async () => undefined),
  getSandboxToolchains: vi.fn(async () => null),
  sandboxEnforces: () => true,
  getSandboxStatus: vi.fn(async () => ({ backend: 'bubblewrap', enforces: true })),
}))
vi.mock('@/lib/coworkGit', () => ({
  loadGitStatus: vi.fn(async () => ({
    branch: 'main',
    repoRoot: '/repo',
    files: [],
    additions: 0,
    deletions: 0,
  })),
  loadGitFileDiff: vi.fn(async () => null),
  repoName: () => 'repo',
  statusBadge: () => 'M',
}))
vi.mock('@/lib/claudeCompatDiscovery', () => ({
  discoverCompatibility: vi.fn(async () => ({
    instructions: [],
    skills: [],
    agents: [],
    mcp: [],
    inert: [],
  })),
}))
vi.mock('@/hooks/useSkills', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useSkills: () => ({ skills: [], enabled: [], loading: false }),
}))
vi.mock('@/lib/coworkSubagentRegistry', () => ({
  listSubagents: vi.fn(async () => []),
}))
vi.mock('@/hooks/useServiceHub', () => {
  const hub = {
    app: () => ({ getJanDataFolder: vi.fn(async () => '/data') }),
    dialog: () => ({ open: vi.fn(async () => '/repo') }),
  }
  return { useServiceHub: () => hub, getServiceHub: () => hub }
})
vi.mock('@/hooks/useModelProvider', () => {
  const useModelProvider: any = (selector?: (s: any) => unknown) =>
    selector ? selector(h.models) : h.models
  useModelProvider.getState = () => h.models
  return { useModelProvider }
})
vi.mock('@/lib/coworkTransport', () => ({
  CoworkChatTransport: class {
    model = 'model-instance'
    advertisedTools: Record<string, unknown> = { read: {}, ask: {}, todo: {} }
    constructor(
      public sessionId: string,
      public config: any
    ) {
      h.transports.push({ sessionId, config })
    }
    setConfig(config: any) {
      this.config = config
    }
    unfreezeTools() {}
    // Project memory is bound per run from the session's own folder.
    memoryBinding: unknown = null
    setMemoryBinding(binding: unknown) {
      this.memoryBinding = binding
    }
    async refreshTools() {}
    measureContext() {
      return {
        categories: {
          instructions: { known: 'estimated', tokens: 1, method: 'test' },
          skills: { known: true, tokens: 0 },
          repositoryMap: { known: true, tokens: 0 },
          conversation: { known: 'estimated', tokens: 1, method: 'test' },
          tools: { known: 'estimated', tokens: 1, method: 'test' },
        },
        budget: { known: 'estimated', tokens: 8192, method: 'test' },
      }
    }
    async sendMessages() {
      return new ReadableStream({ start: (c) => c.close() })
    }
  },
}))
vi.mock('@/lib/coworkRunner', async (orig) => {
  const actual = await orig<typeof import('@/lib/coworkRunner')>()
  return {
    ...actual,
    // Held open until the test settles it: the defect lives in the window
    // between a run starting and it reporting back.
    runTurn: (opts: any) =>
      new Promise((resolve) => {
        // The route names the question it sends `${sid}-user-N`, so the run
        // says which session it belongs to without asking the store.
        const last = opts.messages[opts.messages.length - 1]
        h.runs.push({
          sid: String(last?.id ?? '').split('-user-')[0],
          opts,
          resolve,
        })
      }),
  }
})
vi.mock('@/containers/ChatInput', () => ({
  default: (props: any) => (
    <div data-testid="composer" data-status={props.chatStatus}>
      <button data-testid="submit" onClick={() => props.onSubmit(h.text)}>
        send
      </button>
      <button data-testid="stop" onClick={() => props.onStop?.()}>
        stop
      </button>
    </div>
  ),
}))
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <header>{children}</header>
  ),
}))
vi.mock('@/containers/DropdownModelProvider', () => ({
  default: (props: any) => {
    h.picker = props
    return <div data-testid="picker" data-model={props.model?.id ?? ''} />
  },
}))
vi.mock('@/containers/SkillSelector', () => ({ default: () => <div /> }))
vi.mock('@/containers/MessageItem', () => ({ MessageItem: () => <div /> }))
vi.mock('@/containers/message/CodeOpenProvider', () => ({
  CodeOpenProvider: ({ children }: any) => <>{children}</>,
  useCodeOpen: () => ({ openCode: vi.fn() }),
}))
vi.mock('@/components/ai-elements/conversation', () => ({
  Conversation: ({ children }: any) => <div>{children}</div>,
  ConversationContent: ({ children }: any) => <div>{children}</div>,
  ConversationScrollButton: () => null,
}))
vi.mock('@/components/PromptProgress', () => ({ PromptProgress: () => null }))
vi.mock('@/containers/CoworkCodePanel', () => ({ CoworkCodePanel: () => <div /> }))
vi.mock('@/containers/CoworkPreviewPanel', () => ({
  CoworkPreviewPanel: () => <div />,
}))
vi.mock('@/containers/CoworkTasksPanel', () => ({
  CoworkTasksPanel: () => <div />,
}))

import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { Route } from '@/routes/cowork'
import { getSandboxStatus } from '@/lib/agentTools'
import { useMessageQueue } from '@/stores/message-queue-store'

const CoworkPage = (Route as any).component as () => React.ReactElement

const seed = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    title: id,
    folder: null,
    turns: [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'earlier answer' },
    ],
    messages: [],
    subagents: [],
    created: 1,
    updated: 1,
    mode: 'auto',
    ...over,
  }) as any

const view = (id: string) =>
  act(() => {
    useCoworkSessions.setState({ currentId: id })
  })

const status = () => screen.getByTestId('composer').getAttribute('data-status')

async function startRunIn(id: string) {
  await view(id)
  const before = h.runs.length
  await userEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(h.runs.length).toBe(before + 1))
  return h.runs[h.runs.length - 1]
}

const settle = async (run: HeldRun, over: Record<string, unknown> = {}) => {
  await act(async () => {
    run.resolve({
      messages: run.opts.messages,
      steps: 1,
      usage: null,
      sessionTokens: 0,
      stoppedBy: 'done',
      ...over,
    })
    await Promise.resolve()
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  h.runs = []
  h.transports = []
  h.picker = null
  useCoworkSessions.setState({
    sessions: [seed('A'), seed('B')],
    currentId: 'A',
  })
  useCoworkRun.setState({ runs: {}, outcomes: {}, liveTurns: {}, usage: {} })
  useMessageQueue.setState({ queues: {} })
  render(<CoworkPage />)
  await act(async () => {
    await Promise.resolve()
  })
})

afterEach(async () => {
  // Nothing may be left holding a run open into the next test.
  for (const run of h.runs) await settle(run, { stoppedBy: 'aborted' })
  useCoworkSessions.setState({ sessions: [], currentId: null })
})

describe('a run belongs to the session that started it', () => {
  it('does not make another session look busy', async () => {
    await startRunIn('A')
    expect(status()).toBe('streaming')
    await view('B')
    expect(status()).toBe('ready')
    await view('A')
    expect(status()).toBe('streaming')
  })

  it('lets a second session start a run while the first is still going', async () => {
    const a = await startRunIn('A')
    const b = await startRunIn('B')
    expect(a.sid).toBe('A')
    expect(b.sid).toBe('B')
    expect(a.opts.signal).not.toBe(b.opts.signal)
    expect(Object.keys(useCoworkRun.getState().runs).sort()).toEqual([
      'A',
      'B',
    ])
  })

  it('stops only the viewed session’s run', async () => {
    const a = await startRunIn('A')
    const b = await startRunIn('B')
    await userEvent.click(screen.getByTestId('stop'))
    expect(b.opts.signal.aborted).toBe(true)
    expect(a.opts.signal.aborted).toBe(false)
  })

  it('stopping a session with nothing running cancels nothing elsewhere', async () => {
    const a = await startRunIn('A')
    await view('B')
    await userEvent.click(screen.getByTestId('stop'))
    expect(a.opts.signal.aborted).toBe(false)
  })

  it('reports a completion to its own session after the user switched away', async () => {
    const a = await startRunIn('A')
    await view('B')
    await settle(a, {
      messages: [
        ...a.opts.messages,
        { id: 'A-asst-9', role: 'assistant', parts: [{ type: 'text', text: 'answer for A' }] },
      ],
    })
    await waitFor(() =>
      expect(useCoworkRun.getState().runs.A).toBeUndefined()
    )
    const [sa, sb] = useCoworkSessions.getState().sessions
    expect(JSON.stringify(sa.messages)).toContain('answer for A')
    expect(JSON.stringify(sb.messages)).not.toContain('answer for A')
    expect(status()).toBe('ready')
  })

  it('shows a failure on the session that failed, not on the one in view', async () => {
    const a = await startRunIn('A')
    await view('B')
    await settle(a, { stoppedBy: 'error', errorText: 'provider exploded' })
    await waitFor(() =>
      expect(useCoworkRun.getState().outcomes.A?.stoppedBy).toBe('error')
    )
    expect(useCoworkRun.getState().outcomes.B).toBeUndefined()
  })

  it('keeps a question asked by a background run on that run’s session', async () => {
    const a = await startRunIn('A')
    await view('B')
    let answered: unknown
    act(() => {
      // The model asks, through A's own dispatcher, after the user moved on.
      void a.opts.deps
        .dispatch(
          {
            toolCallId: 'ask-1',
            toolName: 'ask',
            input: {
              questions: [
                {
                  id: 'q1',
                  question: 'Proceed?',
                  options: [{ label: 'Yes' }, { label: 'No' }],
                },
              ],
            },
          },
          new AbortController().signal
        )
        .then((out: unknown) => (answered = out))
    })
    await waitFor(() =>
      expect(JSON.stringify(useCoworkRun.getState().liveTurns.A)).toContain(
        'ask-1'
      )
    )
    expect(useCoworkRun.getState().liveTurns.B).toBeUndefined()
    // Stopping the session in view must not settle A's question.
    await userEvent.click(screen.getByTestId('stop'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(answered).toBeUndefined()
  })

  /// janhq/jan#8864. Input typed into a session while its run works is handed
  /// to that run at a boundary -- only that session's input, marked as
  /// steering in the transcript -- and never to another session's run.
  it('hands a running session only its own typed input, marked as steering', async () => {
    const a = await startRunIn('A')
    const b = await startRunIn('B')
    const queue = useMessageQueue.getState()
    queue.enqueue('A', { id: 'a1', text: 'use pnpm', createdAt: 1 })
    queue.enqueue('A', { id: 'a2', text: 'then test', createdAt: 2 })
    queue.enqueue('B', { id: 'b1', text: 'for B only', createdAt: 3 })
    let taken: any[] = []
    // Async: mailbox messages among the taken input are claimed first.
    await act(async () => {
      taken = await a.opts.deps.takeSteering()
    })
    expect(taken.map((m: any) => m.parts[0].text)).toEqual(['use pnpm', 'then test'])
    expect(taken.every((m: any) => m.role === 'user')).toBe(true)
    // Delivered: gone from the queue, in A's transcript, marked.
    expect(useMessageQueue.getState().getQueue('A')).toEqual([])
    const liveA = useCoworkRun.getState().liveTurns.A ?? []
    expect(liveA.filter((t: any) => t.steered).map((t: any) => t.content)).toEqual([
      'use pnpm',
      'then test',
    ])
    expect(JSON.stringify(useCoworkRun.getState().liveTurns.B ?? [])).not.toContain('use pnpm')
    // B's run gets B's input and nothing of A's.
    let takenB: any[] = []
    await act(async () => {
      takenB = await b.opts.deps.takeSteering()
    })
    expect(takenB.map((m: any) => m.parts[0].text)).toEqual(['for B only'])
    // Each delivery is in its own session's execution record, and the record
    // says only that input arrived: the words stay in the transcript.
    const steering = () =>
      h.invoke.mock.calls
        .filter(([cmd, args]: any[]) => cmd === 'tool_activity_record' && args?.event?.lifecycle === 'steering')
        .map(([, args]: any[]) => args.event)
    await waitFor(() => expect(steering()).toHaveLength(3))
    expect(steering().map((e: any) => e.session).sort()).toEqual(['A', 'A', 'B'])
    expect(JSON.stringify(steering())).not.toMatch(/use pnpm|then test|for B only/)
  })

  it('holds input a failed run did not take, and does not send it on its own', async () => {
    const a = await startRunIn('A')
    useMessageQueue.getState().enqueue('A', { id: 'late', text: 'too late', createdAt: 1 })
    await settle(a, { stoppedBy: 'error', errorText: 'provider exploded' })
    await waitFor(() => expect(useCoworkRun.getState().runs.A).toBeUndefined())
    expect(useMessageQueue.getState().getQueue('A')).toEqual([
      expect.objectContaining({ id: 'late', held: true }),
    ])
    // Idle now, and still no new run for it.
    await act(async () => {
      await Promise.resolve()
    })
    expect(h.runs).toHaveLength(1)
    expect(screen.getByTestId('cowork-held-input')).toHaveTextContent('too late')
  })

  it('sends input typed after a finished run as the next request', async () => {
    const a = await startRunIn('A')
    useMessageQueue.getState().enqueue('A', { id: 'next', text: 'follow up', createdAt: 1 })
    await settle(a)
    await waitFor(() => expect(h.runs).toHaveLength(2))
    expect(h.runs[1].sid).toBe('A')
  })

  /// Found by the real-app two-session Stop scenario. A run is claimed before
  /// it prepares -- probes, the tool list -- and none of that preparation
  /// watched Stop or ended the run: the session stayed running for as long as
  /// a probe took (40 s there), and a probe that failed left it running for
  /// good.
  it('ends a run stopped while it is still preparing', async () => {
    let probed = false
    vi.mocked(getSandboxStatus).mockImplementationOnce(() => {
      probed = true
      return new Promise(() => {})
    })
    await userEvent.click(screen.getByTestId('submit'))
    await waitFor(() => expect(probed).toBe(true))
    expect(useCoworkRun.getState().runs.A).toBeDefined()
    await userEvent.click(screen.getByTestId('stop'))
    await waitFor(() => expect(useCoworkRun.getState().runs.A).toBeUndefined())
    expect(useCoworkRun.getState().outcomes.A?.stoppedBy).toBe('aborted')
    expect(status()).toBe('ready')
    expect(h.runs).toHaveLength(0)
    // What the user asked is kept, as it is for any other ending.
    const [sa] = useCoworkSessions.getState().sessions
    expect(JSON.stringify(sa.turns)).toContain(h.text)
  })

  it('ends a run whose preparation fails, and says why', async () => {
    vi.mocked(getSandboxStatus).mockRejectedValueOnce(new Error('probe exploded'))
    await userEvent.click(screen.getByTestId('submit'))
    await waitFor(() => expect(useCoworkRun.getState().runs.A).toBeUndefined())
    expect(useCoworkRun.getState().outcomes.A).toEqual(
      expect.objectContaining({ stoppedBy: 'error', errorText: 'probe exploded' })
    )
    expect(h.runs).toHaveLength(0)
  })
})

describe('a session’s model', () => {
  it('runs each session on its own model', async () => {
    useCoworkSessions.getState().setModel('A', { provider: 'llamacpp', id: 'model-a' })
    useCoworkSessions.getState().setModel('B', { provider: 'llamacpp', id: 'model-b' })
    await startRunIn('A')
    await startRunIn('B')
    const byTransport = Object.fromEntries(
      h.transports.map((t) => [t.sessionId, t.config.model?.id])
    )
    expect(byTransport).toEqual({ A: 'model-a', B: 'model-b' })
  })

  it('writes a picker change to the session in view only', async () => {
    useCoworkSessions.getState().setModel('A', { provider: 'llamacpp', id: 'model-a' })
    await view('B')
    act(() => {
      h.picker.onModelChange({ provider: 'llamacpp', id: 'model-b' })
    })
    const [sa, sb] = useCoworkSessions.getState().sessions
    expect(sa.model?.id).toBe('model-a')
    expect(sb.model?.id).toBe('model-b')
  })

  it('shows the viewed session’s model in the picker', async () => {
    useCoworkSessions.getState().setModel('A', { provider: 'llamacpp', id: 'model-a' })
    useCoworkSessions.getState().setModel('B', { provider: 'llamacpp', id: 'model-b' })
    await view('B')
    expect(screen.getByTestId('picker').getAttribute('data-model')).toBe('model-b')
    await view('A')
    expect(screen.getByTestId('picker').getAttribute('data-model')).toBe('model-a')
  })
})

describe('work a background run does after the user switched away', () => {
  it('runs its tool calls as its own session', async () => {
    const a = await startRunIn('A')
    await view('B')
    await act(async () => {
      await a.opts.deps.dispatch(
        { toolCallId: 'read-1', toolName: 'read', input: { path: 'notes.txt' } },
        new AbortController().signal
      )
    })
    const sessions = h.executeAgentTool.mock.calls.map((args) => args[2])
    expect(sessions).toContain('A')
    expect(sessions).not.toContain('B')
  })

  it('asks for approval as its own session, not the one in view', async () => {
    useCoworkSessions.setState((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === 'A' ? { ...x, mode: 'ask' } : x
      ),
    }))
    const a = await startRunIn('A')
    await view('B')
    act(() => {
      void a.opts.deps.dispatch(
        {
          toolCallId: 'write-1',
          toolName: 'write',
          input: { path: 'out.txt', content: 'hello' },
        },
        new AbortController().signal
      )
    })
    const { useToolApprovalRequests } = await import(
      '@/hooks/useToolApprovalRequests'
    )
    await waitFor(() =>
      expect(
        Object.values(useToolApprovalRequests.getState().pending).map(
          (p: any) => p.threadId
        )
      ).toContain('A')
    )
    expect(
      Object.values(useToolApprovalRequests.getState().pending).map(
        (p: any) => p.threadId
      )
    ).not.toContain('B')
    // Stopping the session in view leaves A's request waiting.
    await userEvent.click(screen.getByTestId('stop'))
    expect(
      Object.values(useToolApprovalRequests.getState().pending).map(
        (p: any) => p.threadId
      )
    ).toContain('A')
  })
})
