import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useToolApprovalRequests } from '../useToolApprovalRequests'
import { useToolApproval } from '../useToolApproval'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {},
}))
vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { toolApproval: 'tool-approval-settings' },
}))
vi.mock('zustand/middleware', () => ({
  persist: (fn: unknown) => fn,
  createJSONStorage: () => ({
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  i18n: { t: (key: string) => key },
}))

const ROOT = 'C:/proj'
const DEEP = 'C:/proj/src/components'
const WRITE = { path: 'src/components/a.tsx', content: 'x' }
const OFFERED = [
  { type: 'once' },
  { type: 'run' },
  { type: 'folder', dir: DEEP },
  { type: 'folder', dir: ROOT },
]
const BASH = { command: 'cargo test --lib foo' }
const OFFERED_BASH = [
  { type: 'once' },
  { type: 'run' },
  { type: 'command_prefix', prefix: 'cargo test' },
  { type: 'command_prefix', prefix: 'cargo test --lib' },
]

const calls = (name: string) =>
  invokeMock.mock.calls.filter(([command]) => command === name)

function offer(options: unknown[]) {
  invokeMock.mockImplementation(async (command: string) =>
    command === 'agent_approval_scope_options'
      ? options
      : command === 'agent_approval_rule_add'
        ? { id: 'rule-1' }
        : null
  )
}

describe('the scope form on a prompt', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    useToolApprovalRequests.setState({ pending: {}, queued: {}, approvedFingerprints: {} })
    useToolApproval.setState({
      approvedTools: {},
      approvedMcpTools: {},
      approvedServers: [],
      approvedToolsGlobal: [],
      approvedSimilarCalls: [],
      invalidatedServers: [],
      allowAllMCPPermissions: false,
      permissionMode: 'ask',
    })
  })

  const ask = (id: string, tool: string, input: unknown, workspaceLabel = ROOT) =>
    void useToolApprovalRequests
      .getState()
      .requestApproval(id, tool, 'thread-1', undefined, { input, workspaceLabel })

  const formOf = async (id: string) => {
    await vi.waitFor(() =>
      expect(useToolApprovalRequests.getState().pending[id]?.scopeForm).toBeDefined()
    )
    return useToolApprovalRequests.getState().pending[id]!
  }

  it('attaches the backend scopes to a file change, narrowest selected', async () => {
    offer(OFFERED)
    ask('w1', 'write', WRITE)
    const entry = await formOf('w1')
    expect(entry.scopeForm?.root).toBe(ROOT)
    expect(entry.chosenId).toBe(`folder:${DEEP}`)
    expect(entry.choice?.options.at(-1)?.id).toBe('everywhere')
    expect(calls('agent_approval_scope_options')[0][1]).toEqual({
      root: ROOT,
      tool: 'write',
      args: WRITE,
    })
  })

  it('"Always" saves the picked folder as a rule and grants no whole-tool allowance', async () => {
    offer(OFFERED)
    ask('w2', 'write', WRITE)
    await formOf('w2')
    useToolApprovalRequests.getState().resolveApproval('w2', 'allow-always')
    await vi.waitFor(() => expect(calls('agent_approval_rule_add')).toHaveLength(1))
    expect(calls('agent_approval_rule_add')[0][1]).toEqual({
      root: ROOT,
      tool: 'write',
      args: WRITE,
      scope: { type: 'folder', dir: DEEP },
    })
    expect(useToolApproval.getState().approvedToolsGlobal).toEqual([])
  })

  it('saves the longest command prefix for a shell command by default', async () => {
    offer(OFFERED_BASH)
    ask('b1', 'bash', BASH)
    await formOf('b1')
    useToolApprovalRequests.getState().resolveApproval('b1', 'allow-always')
    await vi.waitFor(() => expect(calls('agent_approval_rule_add')).toHaveLength(1))
    expect(calls('agent_approval_rule_add')[0][1].scope).toEqual({
      type: 'command_prefix',
      prefix: 'cargo test --lib',
    })
    expect(useToolApproval.getState().approvedToolsGlobal).toEqual([])
  })

  it('keeps the old whole-tool meaning only when it is picked on purpose', async () => {
    offer(OFFERED)
    ask('w3', 'write', WRITE)
    await formOf('w3')
    useToolApprovalRequests.getState().chooseOption('w3', useToolApprovalRequests.getState().pending['w3']!.requestId, 'everywhere')
    useToolApprovalRequests.getState().resolveApproval('w3', 'allow-always')
    expect(useToolApproval.getState().approvedToolsGlobal).toContain('write')
    expect(calls('agent_approval_rule_add')).toHaveLength(0)
  })

  it('remembers nothing for "Allow once"', async () => {
    offer(OFFERED)
    ask('w4', 'write', WRITE)
    await formOf('w4')
    useToolApprovalRequests.getState().resolveApproval('w4', 'allow-once')
    expect(calls('agent_approval_rule_add')).toHaveLength(0)
    expect(useToolApproval.getState().approvedToolsGlobal).toEqual([])
  })

  it('leaves the prompt as it was when the backend offers no standing scope', async () => {
    offer([{ type: 'once' }, { type: 'run' }])
    ask('w5', 'write', WRITE)
    await vi.waitFor(() => expect(calls('agent_approval_scope_options')).toHaveLength(1))
    await Promise.resolve()
    const entry = useToolApprovalRequests.getState().pending['w5']!
    expect(entry.scopeForm).toBeUndefined()
    expect(entry.choice).toBeUndefined()
    useToolApprovalRequests.getState().resolveApproval('w5', 'allow-always')
    expect(useToolApproval.getState().approvedToolsGlobal).toContain('write')
  })

  it('does not ask the backend for a folder it cannot name, a forced prompt, or another tool', async () => {
    offer(OFFERED)
    ask('x1', 'write', WRITE, 'my project')
    void useToolApprovalRequests
      .getState()
      .requestApproval('x2', 'bash', 'thread-1', undefined, {
        input: { command: 'rm -rf /' },
        workspaceLabel: ROOT,
        workspaceRoots: [ROOT],
      })
    ask('x3', 'read', { path: 'a' })
    await Promise.resolve()
    await Promise.resolve()
    expect(calls('agent_approval_scope_options')).toHaveLength(0)
    for (const id of ['x1', 'x2', 'x3']) {
      expect(useToolApprovalRequests.getState().pending[id]?.scopeForm).toBeUndefined()
    }
  })

  it('does not save a rule for a server tool', async () => {
    offer(OFFERED)
    void useToolApprovalRequests
      .getState()
      .requestApproval('m1', 'write', 'thread-1', 'files-server', {
        serverFingerprint: 'sha256:x',
        input: WRITE,
        workspaceLabel: ROOT,
      })
    await Promise.resolve()
    expect(calls('agent_approval_scope_options')).toHaveLength(0)
  })
})
