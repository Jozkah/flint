/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { useTeamConflictRequests } from '@/hooks/useTeamConflictRequests'

/**
 * The Cowork route, driven end to end.
 *
 * Everything below the route is real: the access decision, the origin ledger,
 * the tool dispatcher, the team orchestrator, the destination planner, the
 * checkpoint chain, the compatibility resolver and every container the route
 * renders. What is replaced is the boundary — Tauri commands, the model, the
 * file picker — because those are the parts a Linux container has no way to
 * provide.
 *
 * This exists because the wiring is where the defects were. Each of the three
 * inert features this branch fixed had correct pure functions on both sides and
 * a route that passed the wrong value between them, and no unit test could have
 * seen any of them. So the assertions here are deliberately about *what crossed
 * the boundary*: which root a tool call carried, which grant, which owner id.
 *
 * What is still native-only, and cannot be asserted here: the Tauri WebView
 * itself (layout, focus order, where a control sits), the real OS sandbox
 * backends, and the real `git` invocations behind the worktree commands. Those
 * are covered by `scripts/cowork-compat-smoke.sh` and the platform workflows.
 */

// ---------------------------------------------------------------------------
// The boundary

const h = vi.hoisted(() => ({
  /** Tauri commands, by name. Tests install answers per case. */
  invoke: vi.fn(),
  getSandboxToolchains: vi.fn(
    async (): Promise<{ runnable: string[]; unavailable: string[] } | null> =>
      null
  ),
  directEditCapability: vi.fn(async () => true),
  managedWorktreeCapability: vi.fn(async () => true),
  directEditAuthorize: vi.fn(async () => 'grant-1'),
  directEditRevoke: vi.fn(async () => true),
  directEditRevokeSession: vi.fn(async () => true),
  projectListDir: vi.fn(async () => []),
  projectReadFile: vi.fn(async () => ''),
  bashJobsList: vi.fn(async () => []),
  executeAgentTool: vi.fn(async () => ({ content: 'ok' })),
  loadGitStatus: vi.fn(async () => ({
    branch: 'main',
    repoRoot: '/repo',
    files: [],
    additions: 0,
    deletions: 0,
  })),
  pickFolder: vi.fn(async () => '/repo'),
  dataFolder: vi.fn(async () => '/data'),
  discoverCompatibility: vi.fn(async () => ({
    instructions: [],
    skills: [],
    agents: [],
    mcp: [],
    inert: [],
  })),
  /** Every transport the route built, newest last. */
  transports: [] as any[],
  /** The last run's dispatcher, captured from `runTurn`. */
  deps: null as any,
  runTurn: vi.fn(),
  listSubagents: vi.fn(async () => []),
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
  /** What the composer sends. Tests change it to drive the classifier. */
  text: 'do the thing',
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({ ...config, id: '/cowork' }),
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
  Link: (props: any) => <a {...props} />,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts && typeof opts === 'object'
        ? `${k}#${Object.values(opts).join(',')}`
        : k,
  }),
}))

vi.mock('sonner', () => ({ toast: h.toast }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))

vi.mock('@janhq/tauri-plugin-agent-tools-api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  directEditCapability: h.directEditCapability,
  managedWorktreeCapability: h.managedWorktreeCapability,
  directEditAuthorize: h.directEditAuthorize,
  directEditRevoke: h.directEditRevoke,
  directEditRevokeSession: h.directEditRevokeSession,
  projectListDir: h.projectListDir,
  projectReadFile: h.projectReadFile,
  bashJobsList: h.bashJobsList,
}))

vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  getLoadedModels: vi.fn(async () => ['local/qwen']),
}))

vi.mock('@/lib/agentTools', () => ({
  executeAgentTool: h.executeAgentTool,
  getSandboxToolchains: h.getSandboxToolchains,
  sandboxEnforces: () => true,
  getSandboxStatus: vi.fn(async () => ({
    backend: 'bubblewrap',
    enforces: true,
  })),
}))

vi.mock('@/lib/coworkGit', () => ({
  loadGitStatus: h.loadGitStatus,
  loadGitFileDiff: vi.fn(async () => null),
  repoName: (p: unknown) =>
    String(p ?? '')
      .split('/')
      .pop() ?? '',
  statusBadge: () => 'M',
}))

vi.mock('@/lib/claudeCompatDiscovery', () => ({
  discoverCompatibility: h.discoverCompatibility,
}))

vi.mock('@/hooks/useSkills', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useSkills: () => ({ skills: [], enabled: [], loading: false }),
}))

vi.mock('@/lib/coworkSubagentRegistry', () => ({
  listSubagents: h.listSubagents,
}))

vi.mock('@/hooks/useServiceHub', () => {
  const hub = {
    app: () => ({ getJanDataFolder: h.dataFolder }),
    dialog: () => ({ open: h.pickFolder }),
  }
  return { useServiceHub: () => hub, getServiceHub: () => hub }
})

vi.mock('@/hooks/useModelProvider', () => {
  const selectedModel = {
    id: 'local/qwen',
    capabilities: ['tools'],
    settings: { ctx_len: { controller_props: { value: 8192 } } },
  }
  const state = {
    selectedModel,
    selectedProvider: 'llamacpp',
    // A run resolves its model from the providers (janhq/jan#8905), not
    // from the bare selection.
    providers: [{ provider: 'llamacpp', active: true, models: [selectedModel] }],
    selectModelProvider: () => {},
  }
  const useModelProvider: any = () => state
  useModelProvider.getState = () => state
  return { useModelProvider }
})

/** The model, replaced. Everything between the composer and the gate is real. */
vi.mock('@/lib/coworkTransport', () => ({
  CoworkChatTransport: class {
    model = 'model-instance'
    advertisedTools: Record<string, unknown> = {
      read: {},
      grep: {},
      write: {},
      bash: {},
      task: {},
      team: {},
      ask: {},
      todo: {},
    }
    constructor(
      public sessionId: string,
      public config: any
    ) {
      h.transports.push(this)
    }
    setConfig(config: any) {
      this.config = config
    }
    unfreezeTools() {}
    memoryBinding: { projectRoot?: string; temporary?: boolean } | undefined
    setMemoryBinding(binding: { projectRoot?: string; temporary?: boolean }) {
      this.memoryBinding = binding
    }
    async refreshTools() {}
    measureContext() {
      return {
        categories: {
          instructions: { known: 'estimated', tokens: 120, method: 'test' },
          skills: { known: true, tokens: 0 },
          repositoryMap: { known: true, tokens: 0 },
          conversation: { known: 'estimated', tokens: 40, method: 'test' },
          tools: { known: 'estimated', tokens: 300, method: 'test' },
        },
        budget: { known: 'estimated', tokens: 8192, method: 'test' },
      }
    }
    async sendMessages() {
      return new ReadableStream({
        start(c) {
          c.close()
        },
      })
    }
  },
}))

// AH-111: a team that ends with failures waits for a person to restart or
// replace a member. Nobody is at the Tasks panel in these tests, so the wait
// is made immediate; its own behaviour is tested in coworkTeamRunControl.
vi.mock('@/lib/coworkTeamControl', async (orig) => ({
  ...(await orig<typeof import('@/lib/coworkTeamControl')>()),
  DECISION_WINDOW_MS: 0,
  COWORK_DECISION_WINDOW_MS: 0,
}))
vi.mock('@/lib/coworkRunner', async (orig) => {
  const actual = await orig<typeof import('@/lib/coworkRunner')>()
  return {
    ...actual,
    runTurn: async (opts: any) => {
      // Captured, not called: each test drives the dispatcher itself, which is
      // exactly the seam a model would exercise.
      h.deps = opts.deps
      h.runTurn(opts)
      return {
        messages: opts.messages,
        steps: 1,
        usage: null,
        sessionTokens: 0,
      }
    },
  }
})

// Heavy chrome, replaced by the smallest thing that keeps the seam.
vi.mock('@/containers/ChatInput', () => ({
  default: (props: any) => (
    <div data-testid="composer">
      {props.surfaceControls}
      <button data-testid="submit" onClick={() => props.onSubmit(h.text)}>
        send
      </button>
      <button data-testid="stop" onClick={() => props.onStop?.()}>
        stop
      </button>
    </div>
  ),
}))
// Renders its children: the session-details control lives in the header, and
// a mock that swallowed them would hide the surface these tests assert on.
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <header>{children}</header>
  ),
}))
vi.mock('@/containers/DropdownModelProvider', () => ({
  default: () => <div />,
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
vi.mock('@/containers/CoworkCodePanel', () => ({
  CoworkCodePanel: (props: any) => (
    <div data-testid="code-panel" data-folder={props.folder ?? ''} />
  ),
}))
vi.mock('@/containers/CoworkPreviewPanel', () => ({
  CoworkPreviewPanel: () => <div />,
}))
vi.mock('@/containers/CoworkTasksPanel', () => ({
  CoworkTasksPanel: (props: any) => (
    <div data-testid="tasks-panel">
      {props.workflows?.flatMap((w: any) =>
        w.tasks.map((task: any) => (
          <div
            key={task.id}
            data-testid={`task-${task.agentName}-${task.callId}`}
            data-status={task.status}
            data-detail={task.detail ?? ''}
            data-parent={task.parentTaskId ?? ''}
          />
        ))
      )}
    </div>
  ),
}))

import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { useCoworkCheckpoints } from '@/hooks/useCoworkCheckpoints'
import { useCoworkOrigins } from '@/hooks/useCoworkOrigins'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { useClaudeCompat } from '@/hooks/useClaudeCompat'
import { Route } from '@/routes/cowork'

const CoworkPage = (Route as any).component as () => React.ReactElement

const SESSION = 'session-under-test'
const FOLDER = '/repo'
const WORKTREE = '/data/worktrees/abcd/session-1234'

const worktreeRecord = (path = WORKTREE) => ({
  path,
  branch: 'jan/cowork/session-1234',
  baseSha: 'a'.repeat(40),
  sourceRoot: FOLDER,
  identity: { root: FOLDER, firstCommit: 'b'.repeat(40) },
  uncommittedAtCreation: [] as string[],
})

/** Tauri commands, answered by name. */
function installInvoke(over: Record<string, (args: any) => unknown> = {}) {
  h.invoke.mockImplementation(async (cmd: string, args: any) => {
    const answer = over[cmd]
    if (answer) return answer(args)
    switch (cmd) {
      case 'agent_worktree_ensure':
        return worktreeRecord()
      case 'agent_worktree_state':
        return 'ready'
      case 'agent_worktree_list':
        return []
      case 'agent_worktree_pending':
        return []
      case 'agent_worktree_discard':
        return undefined
      case 'agent_checkpoint_capture':
        return {
          sha: 'c'.repeat(40),
          label: 'do the thing',
          destination: args?.destination ?? 'managed',
          root: args?.root ?? FOLDER,
        }
      case 'agent_checkpoint_plan':
        return { kind: 'restore', sha: 'c'.repeat(40) }
      case 'agent_checkpoint_restore':
        return undefined
      default:
        return undefined
    }
  })
}

function seedSession(over: Record<string, unknown> = {}) {
  useCoworkSessions.setState({
    sessions: [
      {
        id: SESSION,
        title: 'Session',
        folder: FOLDER,
        turns: [],
        messages: [],
        subagents: [],
        created: 1,
        updated: 1,
        mode: 'auto',
        ...over,
      } as any,
    ],
    currentId: SESSION,
  })
}

const renderRoute = async () => {
  const view = render(<CoworkPage />)
  // The capability query and the folder scans are all promises kicked off on
  // mount; settling them here keeps every test past the loading state.
  await act(async () => {
    await Promise.resolve()
  })
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  installInvoke()
  h.deps = null
  useTeamConflictRequests.setState({ bySession: {} })
  h.directEditCapability.mockResolvedValue(true)
  h.managedWorktreeCapability.mockResolvedValue(true)
  h.directEditAuthorize.mockResolvedValue('grant-1')
  h.pickFolder.mockResolvedValue('/repo')
  h.dataFolder.mockResolvedValue('/data')
  h.listSubagents.mockResolvedValue([])
  h.discoverCompatibility.mockResolvedValue({
    instructions: [],
    skills: [],
    agents: [],
    mcp: [],
    inert: [],
  })
  h.executeAgentTool.mockResolvedValue({ content: 'ok' })
  h.text = 'do the thing'
  useDirectEditGrants.setState({
    capability: { known: false, reason: 'loading' },
    bySession: {},
    generation: 0,
  })
  useCoworkWorktrees.setState({ bySession: {}, errorBySession: {} })
  useCoworkCheckpoints.setState({ bySession: {} })
  useCoworkOrigins.setState({ bySession: {} } as any)
  useCoworkActivity.setState({ tasks: {}, workflows: {} } as any)
  useClaudeCompat.setState({ folders: {}, skillRoots: [] } as any)
  seedSession()
})

afterEach(() => {
  useCoworkSessions.setState({ sessions: [], currentId: null })
})

/**
 * The window width the route sees, through the same `matchMedia` its media
 * queries read. Only `max-width` queries are answered, which is all it asks.
 */
function setViewport(width: number) {
  ;(window.matchMedia as any).mockImplementation((query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query)?.[1]
    return {
      matches: max !== undefined && width <= Number(max),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
  })
}

/** The `hidden` utility itself, not a class that merely contains the word. */
const isHidden = (el: HTMLElement) => el.classList.contains('hidden')

describe('the layout at each width', () => {
  afterEach(() => setViewport(4000))

  it('docks the output panel on a wide window, with one set of rail tabs', async () => {
    setViewport(1440)
    await renderRoute()
    // Closed: the rail buttons are in the composer row.
    expect(screen.getAllByRole('button', { name: 'common:rail.code' })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'common:rail.code' }))

    const inspector = await screen.findByTestId('cowork-inspector')
    expect(inspector).toHaveAttribute('data-layout', 'docked')
    // Open: the same buttons, once, in the panel header, still pressed.
    const code = screen.getAllByRole('button', { name: 'common:rail.code' })
    expect(code).toHaveLength(1)
    expect(inspector.contains(code[0])).toBe(true)
    expect(code[0]).toHaveAttribute('aria-pressed', 'true')

    // Pressing the open tab again closes it, as the toolbar always did.
    await userEvent.click(code[0])
    await waitFor(() =>
      expect(screen.queryByTestId('cowork-inspector')).toBeNull()
    )
  })

  it('puts the panel in a drawer below 1100px that its scrim closes', async () => {
    setViewport(900)
    await renderRoute()
    await userEvent.click(screen.getByRole('button', { name: 'common:rail.code' }))
    const inspector = await screen.findByTestId('cowork-inspector')
    expect(inspector).toHaveAttribute('data-layout', 'drawer')

    await userEvent.click(
      screen.getByRole('button', { name: 'common:rail.closeOverlay' })
    )
    await waitFor(() =>
      expect(screen.queryByTestId('cowork-inspector')).toBeNull()
    )
    expect(
      screen.getByRole('button', { name: 'common:rail.code' })
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows one view at a time on a phone, keeping the composer mounted', async () => {
    setViewport(390)
    await renderRoute()
    const switcher = await screen.findByRole('group', {
      name: 'common:coworkLayout.views',
    })
    expect(switcher).toBeInTheDocument()
    expect(screen.getByTestId('cowork-view-content')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    // The details control is a view here, not a dialog in the bar.
    expect(screen.queryByTestId('session-details-trigger')).toBeNull()

    await userEvent.click(screen.getByTestId('cowork-view-output'))
    const inspector = await screen.findByTestId('cowork-inspector')
    expect(inspector).toHaveAttribute('data-layout', 'full')
    expect(isHidden(screen.getByTestId('cowork-content-view'))).toBe(true)
    // Hidden, not unmounted: the draft lives in the composer.
    expect(screen.getByTestId('composer')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'common:rail.code' })).toHaveLength(1)

    // Choosing a tab keeps the output view and marks the tab.
    await userEvent.click(screen.getByRole('button', { name: 'common:rail.code' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'common:rail.code' })
      ).toHaveAttribute('aria-pressed', 'true')
    )
    expect(screen.getByTestId('cowork-view-output')).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'common:coworkLayout.back' })
    )
    await waitFor(() =>
      expect(isHidden(screen.getByTestId('cowork-content-view'))).toBe(false)
    )
    expect(screen.queryByTestId('cowork-inspector')).toBeNull()

    await userEvent.click(screen.getByTestId('cowork-view-details'))
    expect(await screen.findByTestId('cowork-details-view')).toBeInTheDocument()
    expect(screen.getByTestId('session-details-body')).toBeInTheDocument()
  })
})

/**
 * A session that has already had a turn.
 *
 * The opening turn of a bound session is deliberately review-only — the
 * classifier answers an ambiguous first request with a proposal — so a test
 * about what a *working* run may write has to be past that, exactly as a real
 * session is.
 */
const PRIOR_TURNS = [
  { role: 'user', content: 'earlier question' },
  { role: 'assistant', content: 'earlier answer' },
] as any[]

/** Send a turn and hand back the dispatcher the route built for it. */
async function runOneTurn() {
  await userEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(h.deps).not.toBeNull())
  return h.deps
}

const call = (name: string, input: unknown, id = 'c1') => ({
  toolCallId: id,
  toolName: name,
  input,
})

/** Open the access menu and choose one mode. */
async function chooseAccess(mode: string) {
  await userEvent.click(
    screen.getByRole('button', { name: 'common:coworkAccess.label' })
  )
  await userEvent.click(
    await screen.findByText(`common:coworkAccess.${mode}.label`)
  )
}

describe('what a run carries, decided by the route', () => {
  it('writes nowhere in review only, whatever the folder is', async () => {
    await renderRoute()
    const deps = await runOneTurn()

    await deps.dispatch(call('read', { path: 'src/index.ts' }))

    expect(h.executeAgentTool).toHaveBeenCalledWith(
      'read',
      { path: 'src/index.ts' },
      SESSION,
      expect.objectContaining({ readOnlyProject: FOLDER, writeGrant: null })
    )
  })

  it('carries the grant, and the folder, once direct editing is confirmed', async () => {
    seedSession({ turns: PRIOR_TURNS })
    await renderRoute()
    await chooseAccess('edit-folder')
    // Selecting is not confirming: the dialog is the second half.
    expect(h.directEditAuthorize).not.toHaveBeenCalled()

    await userEvent.click(
      await screen.findByText('common:coworkAccess.confirm.confirm')
    )
    await waitFor(() =>
      expect(h.directEditAuthorize).toHaveBeenCalledWith(
        '/data',
        SESSION,
        FOLDER
      )
    )

    const deps = await runOneTurn()
    await deps.dispatch(call('write', { path: 'a.ts', content: 'x' }))

    expect(h.executeAgentTool).toHaveBeenCalledWith(
      'write',
      expect.anything(),
      SESSION,
      expect.objectContaining({
        readOnlyProject: FOLDER,
        writeGrant: 'grant-1',
      })
    )
  })

  it('reads and writes the worktree, not the checkout, in managed mode', async () => {
    // The defect this branch fixed, asserted where it lived: the mode was
    // chosen, the worktree made, the grant issued — and the run used none of
    // it.
    seedSession({ turns: PRIOR_TURNS })
    await renderRoute()
    await chooseAccess('managed-worktree')

    await waitFor(() =>
      expect(h.directEditAuthorize).toHaveBeenCalledWith(
        '/data',
        SESSION,
        WORKTREE
      )
    )
    expect(h.invoke).toHaveBeenCalledWith(
      'agent_worktree_ensure',
      expect.objectContaining({ project: FOLDER, sessionId: SESSION })
    )

    const deps = await runOneTurn()
    await deps.dispatch(call('write', { path: 'a.ts', content: 'x' }))

    expect(h.executeAgentTool).toHaveBeenCalledWith(
      'write',
      expect.anything(),
      SESSION,
      expect.objectContaining({
        readOnlyProject: WORKTREE,
        writeGrant: 'grant-1',
      })
    )
    // Memory follows the project, not the tree this run reads: a managed
    // worktree is the same project, so it must recall the attached folder's
    // memory rather than start a project of its own.
    expect(h.transports.at(-1)?.memoryBinding).toEqual({
      projectRoot: FOLDER,
      temporary: false,
    })
  })

  it('tells the model which toolchains the sandbox can run', async () => {
    h.getSandboxToolchains.mockResolvedValueOnce({
      runnable: ['node', 'npm'],
      unavailable: ['python', 'git'],
    })
    await renderRoute()
    await runOneTurn()
    expect(h.transports.at(-1)?.config).toEqual(
      expect.objectContaining({
        runnable: ['node', 'npm'],
        unavailable: ['python', 'git'],
      })
    )
  })

  it('does not start a run against a worktree that is no longer there', async () => {
    await renderRoute()
    await chooseAccess('managed-worktree')
    await waitFor(() => expect(h.directEditAuthorize).toHaveBeenCalled())

    installInvoke({ agent_worktree_state: () => 'missing' })
    await userEvent.click(screen.getByTestId('submit'))

    // Nothing ran, the authority is gone, and the user is told which of the
    // ways a worktree can go stale happened.
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled())
    expect(h.runTurn).not.toHaveBeenCalled()
    // The grant it was holding is handed back, not merely forgotten here.
    expect(h.directEditRevoke).toHaveBeenCalledWith('grant-1')
  })

  it('keeps a session in review when the platform cannot confine writes', async () => {
    h.directEditCapability.mockResolvedValue(false)
    h.managedWorktreeCapability.mockResolvedValue(false)
    seedSession({ turns: PRIOR_TURNS })
    await renderRoute()

    await userEvent.click(
      screen.getByRole('button', { name: 'common:coworkAccess.label' })
    )
    const option = (
      await screen.findByText('common:coworkAccess.edit-folder.label')
    ).closest('[role="menuitemradio"]')
    expect(option).toHaveAttribute('aria-disabled', 'true')

    // The menu stays open on a choice that cannot be made, so the reason stays
    // on screen; dismiss it before driving the composer.
    await userEvent.keyboard('{Escape}')
    const deps = await runOneTurn()
    await deps.dispatch(call('write', { path: 'a.ts', content: 'x' }))
    expect(h.executeAgentTool).toHaveBeenCalledWith(
      'write',
      expect.anything(),
      SESSION,
      expect.objectContaining({ writeGrant: null })
    )
  })

  it('drops a grant that arrives for a folder nobody is on any more', async () => {
    // The stale reply: the picker moved the session while the backend was
    // still answering. A grant kept here would be authority nobody asked for.
    let release: (id: string) => void = () => {}
    h.directEditAuthorize.mockImplementation(
      () => new Promise<string>((resolve) => (release = resolve))
    )
    await renderRoute()
    await chooseAccess('edit-folder')
    await userEvent.click(
      await screen.findByText('common:coworkAccess.confirm.confirm')
    )

    act(() => {
      useCoworkSessions.getState().setFolder(SESSION, '/somewhere-else')
    })
    await act(async () => {
      release('grant-late')
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(h.directEditRevoke).toHaveBeenCalledWith('grant-late')
    )
    expect(useDirectEditGrants.getState().bySession[SESSION]).toBeUndefined()
  })
})

describe('the second gate, which exists to disagree with the first', () => {
  it('carries nothing when the grant on file was issued to another session', async () => {
    seedSession({ turns: PRIOR_TURNS })
    await renderRoute()
    await chooseAccess('edit-folder')
    await userEvent.click(
      await screen.findByText('common:coworkAccess.confirm.confirm')
    )
    await waitFor(() => expect(h.directEditAuthorize).toHaveBeenCalled())

    // A grant held for a different session is not this session's authority,
    // however the preference reads.
    act(() => {
      useDirectEditGrants.setState((prev) => ({
        bySession: {
          ...prev.bySession,
          [SESSION]: {
            sessionId: 'someone-else',
            folder: FOLDER,
            grantId: 'grant-1',
          },
        },
      }))
    })

    const deps = await runOneTurn()
    await deps.dispatch(call('write', { path: 'a.ts', content: 'x' }))

    // The run went ahead — into its sandbox, carrying nothing.
    expect(h.executeAgentTool).toHaveBeenCalledWith(
      'write',
      expect.anything(),
      SESSION,
      expect.objectContaining({ writeGrant: null })
    )
  })

  it('refuses a change a skill the user asked for never reached', async () => {
    seedSession({ turns: PRIOR_TURNS })
    await renderRoute()
    await chooseAccess('managed-worktree')
    await waitFor(() => expect(h.directEditAuthorize).toHaveBeenCalled())

    h.text = 'use the missing-skill skill and rename the parser'
    const deps = await runOneTurn()
    const result = await deps.dispatch(
      call('write', { path: 'a.ts', content: 'x' })
    )

    expect(result.isError).toBe(true)
    expect(h.executeAgentTool).not.toHaveBeenCalled()
  })
})

describe('a team, dispatched by the route', () => {
  it('gives an isolated child its own worktree, grant and owner', async () => {
    const made: string[] = []
    installInvoke({
      agent_worktree_ensure: (args: any) => {
        made.push(args.sessionId)
        return worktreeRecord(`/data/worktrees/abcd/${args.sessionId}`)
      },
    })
    h.directEditAuthorize.mockImplementation(
      async (_d: string, owner: string) => `grant-${owner}`
    )
    await renderRoute()
    const deps = await runOneTurn()

    const result = await deps.dispatch(
      call('team', {
        tasks: [
          { id: 'a', description: 'do a', isolate: true },
          { id: 'b', description: 'do b', isolate: true },
        ],
      })
    )

    // Two children, two checkouts, two grants — provisioned before either
    // started.
    const children = made.filter((one) => one.includes('--child-'))
    expect(new Set(children).size).toBe(2)
    expect(result.output).toContain('own checkout')
    // And the authority goes back when the team is over.
    await waitFor(() =>
      expect(h.directEditRevoke).toHaveBeenCalledWith(
        expect.stringContaining('--child-')
      )
    )
  })

  it('refuses the whole team when one checkout cannot be made', async () => {
    h.directEditAuthorize.mockImplementation(
      async (_d: string, owner: string) => `grant-${owner}`
    )
    installInvoke({
      agent_worktree_ensure: (args: any) => {
        if (String(args.sessionId).endsWith('b')) {
          throw new Error('branch jan/cowork/x already exists')
        }
        return worktreeRecord(`/data/worktrees/abcd/${args.sessionId}`)
      },
    })
    await renderRoute()
    const deps = await runOneTurn()

    const result = await deps.dispatch(
      call('team', {
        tasks: [
          { id: 'a', description: 'do a', isolate: true },
          { id: 'b', description: 'do b', isolate: true },
        ],
      })
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('already exists')
    // Half a team isolated is worse than none: the one that succeeded does
    // not keep the authority it was given.
    expect(h.directEditRevoke).toHaveBeenCalledWith(
      expect.stringContaining('--child-a')
    )
  })

  it('asks about overlapping tasks before anything is provisioned, and runs nothing when declined', async () => {
    await renderRoute()
    const deps = await runOneTurn()

    const pending = deps.dispatch(
      call('team', {
        tasks: [
          { id: 'a', description: 'do a', writes: ['src/x.ts'], isolate: true },
          { id: 'b', description: 'do b', writes: ['SRC\\x.ts'], isolate: true },
        ],
      })
    )

    // AH-109: the overlap goes to the person, named by both tasks and the
    // path, while nothing has been provisioned or dispatched.
    await waitFor(() =>
      expect(
        Object.values(useTeamConflictRequests.getState().bySession)
      ).toHaveLength(1)
    )
    const request = Object.values(useTeamConflictRequests.getState().bySession)[0]
    expect(request.conflicts[0].tasks).toEqual(['a', 'b'])
    expect(await screen.findByTestId('team-conflicts')).toBeInTheDocument()
    expect(h.invoke).not.toHaveBeenCalledWith(
      'agent_worktree_ensure',
      expect.anything()
    )

    act(() =>
      useTeamConflictRequests
        .getState()
        .answer(request.sessionId, { kind: 'cancel' })
    )
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.output).toContain('chose not to run')
    expect(h.invoke).not.toHaveBeenCalledWith(
      'agent_worktree_ensure',
      expect.anything()
    )
  })

  it('still refuses a graph that could not finish, without asking anyone', async () => {
    await renderRoute()
    const deps = await runOneTurn()
    const result = await deps.dispatch(
      call('team', {
        tasks: [{ id: 'a', description: 'do a', dependsOn: [], depends_on: ['ghost'] }],
      })
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('ghost')
    expect(useTeamConflictRequests.getState().bySession).toEqual({})
  })

  it('shows the team as one unit of work with its children under it', async () => {
    await renderRoute()
    const deps = await runOneTurn()
    await deps.dispatch(
      call('team', {
        tasks: [{ id: 'a', description: 'do a' }],
      })
    )

    const tasks = Object.values(useCoworkActivity.getState().tasks) as any[]
    const team = tasks.find((one) => one.agentName === 'team')
    expect(team).toBeTruthy()
    // The child hangs under the team rather than appearing as an unrelated
    // errand.
    expect(tasks.some((one) => one.parentTaskId === team.id)).toBe(true)
  })
})

/**
 * Readiness, compatibility, skill folders and context accounting live behind
 * the session-details control now -- they are reference material, not part of
 * the conversation -- so a test that asserts on them has to open it first.
 */
async function openSessionDetails() {
  fireEvent.click(await screen.findByTestId('session-details-trigger'))
  return await screen.findByTestId('session-details-body')
}

describe('what the route says about the run', () => {
  it('names the worktree, its branch and what it cannot see', async () => {
    installInvoke({
      agent_worktree_ensure: () => ({
        ...worktreeRecord(),
        uncommittedAtCreation: ['src/edited.ts'],
      }),
    })
    await renderRoute()
    await chooseAccess('managed-worktree')

    await openSessionDetails()
    const card = await screen.findByRole('region', {
      name: 'common:readiness.title',
    })
    await waitFor(() => expect(card).toHaveTextContent(WORKTREE))
    expect(card).toHaveTextContent('jan/cowork/session-1234')
    expect(card).toHaveTextContent('common:readiness.worktree.unseen.value#1')
  })

  it('reports the tree the changes are in, not the folder attached', async () => {
    h.loadGitStatus.mockImplementation(async (root: string) => ({
      branch: 'main',
      repoRoot: root,
      files:
        root === WORKTREE
          ? [
              {
                path: 'a.ts',
                origPath: null,
                status: 'modified',
                staged: false,
                unstaged: true,
                additions: 1,
                deletions: 0,
                binary: false,
              },
            ]
          : [],
      additions: root === WORKTREE ? 1 : 0,
      deletions: 0,
    }))
    await renderRoute()
    await chooseAccess('managed-worktree')
    await waitFor(() => expect(h.directEditAuthorize).toHaveBeenCalled())

    await waitFor(() =>
      expect(h.loadGitStatus).toHaveBeenCalledWith(WORKTREE, expect.anything())
    )

    const deps = await runOneTurn()
    await deps.dispatch(call('write', { path: 'a.ts', content: 'x' }))

    // The origin ledger is written against the worktree, so a real change is
    // attributable rather than filed as external.
    await waitFor(() => {
      const recorded = useCoworkOrigins.getState().bySession[SESSION]
      expect(recorded?.summary.tree).toBe(WORKTREE)
    })
  })

  it('takes a checkpoint before a run that can change something, and none before one that cannot', async () => {
    await renderRoute()
    await runOneTurn()
    // Review only: nothing to undo, so nothing is recorded.
    expect(h.invoke).not.toHaveBeenCalledWith(
      'agent_checkpoint_capture',
      expect.anything()
    )

    await chooseAccess('managed-worktree')
    await waitFor(() => expect(h.directEditAuthorize).toHaveBeenCalled())
    await runOneTurn()

    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith(
        'agent_checkpoint_capture',
        expect.objectContaining({
          root: WORKTREE,
          destination: 'managed',
          threadId: SESSION,
        })
      )
    )
  })

  it('offers a rewind that restores only where Jan owns the tree', async () => {
    useCoworkCheckpoints.setState({
      bySession: {
        [SESSION]: [
          {
            sha: 'c'.repeat(40),
            label: 'earlier turn',
            destination: 'managed',
            root: WORKTREE,
            at: 1,
            access: 'managed-worktree',
          },
        ],
      },
    })
    await renderRoute()
    await chooseAccess('managed-worktree')
    await waitFor(() => expect(h.directEditAuthorize).toHaveBeenCalled())

    await userEvent.click(
      screen.getByRole('button', { name: 'common:rail.changes' })
    )
    await userEvent.click(await screen.findByText('common:rewind.goBack'))
    // Planning changes nothing; the restore waits for the confirmation.
    expect(h.invoke).not.toHaveBeenCalledWith(
      'agent_checkpoint_restore',
      expect.anything()
    )

    await userEvent.click(
      await screen.findByText('common:rewind.confirmRestore')
    )
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith(
        'agent_checkpoint_restore',
        expect.objectContaining({ latest: 'c'.repeat(40) })
      )
    )
  })

  it('offers the work a crashed run left behind, without restoring access to it', async () => {
    installInvoke({
      agent_worktree_list: () => [
        worktreeRecord('/data/worktrees/abcd/orphan'),
      ],
    })
    await renderRoute()

    const panel = await screen.findByTestId('cowork-worktree-recovery')
    expect(panel).toHaveTextContent('/data/worktrees/abcd/orphan')

    await userEvent.click(screen.getByText('common:worktreeRecovery.use'))

    // Adopting tells the session where the work is. It does not make it
    // writable: no grant is issued, the session holds none, and the run that
    // follows carries none.
    expect(h.directEditAuthorize).not.toHaveBeenCalled()
    expect(useDirectEditGrants.getState().bySession[SESSION]).toBeUndefined()
    expect(useCoworkWorktrees.getState().bySession[SESSION]?.path).toBe(
      '/data/worktrees/abcd/orphan'
    )

    const deps = await runOneTurn()
    await deps.dispatch(call('read', { path: 'a.ts' }))
    expect(h.executeAgentTool).toHaveBeenCalledWith(
      'read',
      expect.anything(),
      SESSION,
      expect.objectContaining({ writeGrant: null })
    )
  })
})

describe('a repository that brings its own configuration', () => {
  const withAgent = {
    instructions: [],
    skills: [],
    agents: [
      {
        name: 'reviewer',
        path: `${FOLDER}/.claude/agents/reviewer.md`,
        description: 'reviews the parser',
        tools: ['read', 'grep'],
        content: 'You review parsers.',
        canonicalInside: true,
      },
    ],
    mcp: [],
    inert: [],
  }

  it('dispatches an imported agent, with the tools it was granted', async () => {
    h.discoverCompatibility.mockResolvedValue(withAgent as any)
    useClaudeCompat.setState({
      folders: { [FOLDER]: { enabled: true } },
      skillRoots: [],
    } as any)
    await renderRoute()

    const deps = await runOneTurn()
    const result = await deps.dispatch(
      call('task', { subagent_name: 'reviewer', description: 'look at it' })
    )

    // It ran: an unknown agent would have come back as an error naming it.
    expect(result.output).not.toContain("unknown subagent 'reviewer'")
  })

  it('will not let a repository redefine an agent the user saved', async () => {
    h.listSubagents.mockResolvedValue([
      {
        name: 'reviewer',
        description: 'the user’s own',
        system_prompt: 'You are the saved one.',
        allowed_tools: null,
        model: null,
      },
    ] as any)
    h.discoverCompatibility.mockResolvedValue(withAgent as any)
    useClaudeCompat.setState({
      folders: { [FOLDER]: { enabled: true } },
      skillRoots: [],
    } as any)
    await renderRoute()
    await openSessionDetails()

    // The saved definition keeps the name; the imported one is reported as a
    // duplicate rather than quietly losing. Waited for as one condition: the
    // saved list and the repository scan arrive independently, and asserting
    // the second as soon as the first had rendered raced them.
    await waitFor(() => {
      const section = screen.getByTestId('cowork-compat')
      expect(section).toHaveTextContent('reviewer')
      expect(section).toHaveTextContent('duplicate')
    })
  })

  it('reports a local MCP server it cannot confine rather than running it', async () => {
    h.discoverCompatibility.mockResolvedValue({
      instructions: [],
      skills: [],
      agents: [],
      mcp: [
        {
          name: 'deployer',
          source: 'project',
          path: `${FOLDER}/.mcp.json`,
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          envNames: ['TOKEN'],
        },
      ],
      inert: [],
    } as any)
    useClaudeCompat.setState({
      folders: { [FOLDER]: { enabled: true } },
      skillRoots: [],
    } as any)
    await renderRoute()
    await openSessionDetails()

    const section = await screen.findByTestId('cowork-compat')
    expect(section).toHaveTextContent('deployer')
    // The names it would be given are shown with the question, because
    // allowing a server without saying what it gets is not a question anyone
    // can answer.
    expect(section).toHaveTextContent('TOKEN')
  })
})

describe('the folder the session is bound to', () => {
  it('stops a run when the folder is taken away mid-turn', async () => {
    await renderRoute()
    const deps = await runOneTurn()

    act(() => {
      useCoworkSessions.getState().setFolder(SESSION, null)
    })
    const result = await deps.dispatch(call('read', { path: 'a.ts' }))

    expect(result.isError).toBe(true)
    expect(h.executeAgentTool).not.toHaveBeenCalled()
  })

  it('attaches what the picker returned, and nothing else', async () => {
    seedSession({ folder: null })
    h.pickFolder.mockResolvedValue('/another/repo')
    await renderRoute()

    await userEvent.click(
      screen.getByRole('button', { name: 'common:workspace.a11yNoFolder' })
    )
    await userEvent.click(await screen.findByText('common:workspace.attach'))

    await waitFor(() =>
      expect(
        useCoworkSessions.getState().sessions.find((one) => one.id === SESSION)
          ?.folder
      ).toBe('/another/repo')
    )
  })
})
