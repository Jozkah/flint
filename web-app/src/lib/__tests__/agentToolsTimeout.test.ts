import { beforeEach, expect, it, vi } from 'vitest'

const advertisedToolSchemas = vi.fn()
const executeTool = vi.fn()
const executeToolStreaming = vi.fn()
const getJanDataFolder = vi.fn()

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  advertisedToolSchemas: (...args: unknown[]) => advertisedToolSchemas(...args),
  executeTool: (...args: unknown[]) => executeTool(...args),
  executeToolStreaming: (...args: unknown[]) => executeToolStreaming(...args),
  executeToolUnsandboxedRetry: vi.fn(),
  executeToolUnsandboxedWithdraw: vi.fn(),
  previewChange: vi.fn(),
  sandboxStatus: vi.fn().mockResolvedValue({ backend: 'bubblewrap', enforces: true }),
  sandboxToolchains: vi.fn(),
  threadWorkspaceDelete: vi.fn(),
  threadWorkspaceSweep: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (m: unknown) => void = () => {}
  },
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder }) }),
}))

beforeEach(() => {
  executeTool.mockReset()
  executeToolStreaming.mockReset()
  getJanDataFolder.mockReset().mockResolvedValue('/data')
})

it('accepts the 120 second bash boundary and rejects anything above it', async () => {
  const { agentToolInputError, MAX_BASH_TIMEOUT_SECS } = await import(
    '../agentTools'
  )

  expect(MAX_BASH_TIMEOUT_SECS).toBe(120)
  expect(agentToolInputError('bash', { command: 'x', timeout: 120 })).toBeNull()
  expect(agentToolInputError('bash', { command: 'x' })).toBeNull()
  expect(agentToolInputError('read', { timeout: 999 })).toBeNull()

  const error = agentToolInputError('bash', {
    command: 'long build',
    timeout: 121,
  })
  expect(error).toContain('121s exceeds the 120s foreground limit')
  expect(error).toContain('background: true')
  expect(error).toContain('omit timeout')
})

it('rejects an oversized bash timeout before any backend call starts', async () => {
  const { executeAgentTool } = await import('../agentTools')

  const result = await executeAgentTool(
    'bash',
    { command: 'npm test', timeout: 600 },
    'thread-1'
  )

  expect(result.error).toContain('600s exceeds the 120s foreground limit')
  expect(result.error).toContain('Do not retry with a larger timeout')
  expect(getJanDataFolder).not.toHaveBeenCalled()
  expect(executeTool).not.toHaveBeenCalled()
  expect(executeToolStreaming).not.toHaveBeenCalled()
})
