import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const threadWorkspacePath = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  threadWorkspacePath: (...args: unknown[]) => threadWorkspacePath(...args),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    app: () => ({ getJanDataFolder: async () => '/data' }),
  }),
}))

import {
  chatDestructiveReason,
  chatForcedPrompt,
  chatWorkspaceRoots,
} from '../chatToolGuard'
import {
  DEFAULT_AUTO_APPROVE_LIMIT,
  resetAutoApproveStreak,
  useAutoApproveLimit,
} from '@/hooks/useAutoApproveLimit'

const WS = '/data/threads/t1/workspace'

describe('chatToolGuard', () => {
  beforeEach(() => {
    invoke.mockReset()
    threadWorkspacePath.mockReset()
    threadWorkspacePath.mockResolvedValue(WS)
    useAutoApproveLimit.getState().setLimit(DEFAULT_AUTO_APPROVE_LIMIT)
    resetAutoApproveStreak('t1')
  })

  it("scopes Chat's shell to the thread workspace", async () => {
    expect(await chatWorkspaceRoots('t1')).toEqual([WS])
    expect(threadWorkspacePath).toHaveBeenCalledWith('/data', 't1')
    threadWorkspacePath.mockRejectedValueOnce(new Error('no'))
    expect(await chatWorkspaceRoots('t1')).toEqual([])
  })

  it('asks the desktop, which resolves paths through the filesystem', async () => {
    invoke.mockResolvedValueOnce(null)
    expect(await chatDestructiveReason(`rm -rf ${WS}/build`, [WS])).toBeNull()
    expect(invoke).toHaveBeenCalledWith('agent_destructive_reason', {
      command: `rm -rf ${WS}/build`,
      roots: [WS],
    })
    invoke.mockResolvedValueOnce(
      '`rm -rf /x` deletes `/x`, outside the workspace'
    )
    expect(await chatDestructiveReason('rm -rf /x', [WS])).toMatch(/outside/)
  })

  it('falls back to the text check against the same roots, erring toward asking', async () => {
    invoke.mockRejectedValue(new Error('unavailable'))
    expect(await chatDestructiveReason(`rm -rf ${WS}/build`, [WS])).toBeNull()
    expect(await chatDestructiveReason('rm -rf /etc', [WS])).not.toBeNull()
    expect(
      await chatDestructiveReason(`rm -rf ${WS}/../x`, [WS])
    ).not.toBeNull()
    expect(await chatDestructiveReason(`rm -rf ${WS}/build`, [])).not.toBeNull()
  })

  it('an absolute path inside the workspace is not asked about', async () => {
    invoke.mockResolvedValue(null)
    expect(
      await chatForcedPrompt(
        'bash',
        { command: `rm -rf "${WS}/out dir"` },
        't1'
      )
    ).toBeNull()
    expect(invoke).toHaveBeenCalledWith('agent_destructive_reason', {
      command: `rm -rf "${WS}/out dir"`,
      roots: [WS],
    })
  })

  it('a destructive command is asked about and starts the count over', async () => {
    useAutoApproveLimit.getState().setLimit(2)
    invoke.mockResolvedValueOnce(null)
    expect(await chatForcedPrompt('bash', { command: 'ls' }, 't1')).toBeNull()
    invoke.mockResolvedValueOnce(
      '`rm -rf ~` deletes `~`, outside the workspace'
    )
    const forced = await chatForcedPrompt('bash', { command: 'rm -rf ~' }, 't1')
    expect(forced?.reason).toMatch(/^Destructive command: /)
    // The count started over: two more run before the pause.
    expect(await chatForcedPrompt('read', {}, 't1')).toBeNull()
    expect(await chatForcedPrompt('read', {}, 't1')).toBeNull()
    expect(await chatForcedPrompt('read', {}, 't1')).not.toBeNull()
  })

  it('pauses after the default limit of 50', async () => {
    for (let i = 0; i < DEFAULT_AUTO_APPROVE_LIMIT; i++) {
      expect(await chatForcedPrompt('read', {}, 't1')).toBeNull()
    }
    const forced = await chatForcedPrompt('read', {}, 't1')
    expect(forced?.reason).toBe('50 tool calls ran without asking. Continue?')
    // Asked: the next one runs again.
    expect(await chatForcedPrompt('read', {}, 't1')).toBeNull()
  })

  it('never pauses when the limit is 0', async () => {
    useAutoApproveLimit.getState().setLimit(0)
    for (let i = 0; i < 200; i++) {
      expect(await chatForcedPrompt('read', {}, 't1')).toBeNull()
    }
  })

  it('uses a custom limit, the maximum, and the default for malformed input', async () => {
    useAutoApproveLimit.getState().setLimit(3)
    for (let i = 0; i < 3; i++)
      expect(await chatForcedPrompt('read', {}, 't1')).toBeNull()
    expect(await chatForcedPrompt('read', {}, 't1')).not.toBeNull()

    useAutoApproveLimit.getState().setLimit(99999)
    expect(useAutoApproveLimit.getState().limit).toBe(1000)
    for (let i = 0; i < 1000; i++)
      expect(await chatForcedPrompt('read', {}, 't1')).toBeNull()
    expect((await chatForcedPrompt('read', {}, 't1'))?.reason).toMatch(/^1000 /)

    useAutoApproveLimit.getState().setLimit('not a number')
    expect(useAutoApproveLimit.getState().limit).toBe(
      DEFAULT_AUTO_APPROVE_LIMIT
    )
  })

  it('counts each conversation separately', async () => {
    useAutoApproveLimit.getState().setLimit(1)
    expect(await chatForcedPrompt('read', {}, 't1')).toBeNull()
    expect(await chatForcedPrompt('read', {}, 't2')).toBeNull()
    expect(await chatForcedPrompt('read', {}, 't1')).not.toBeNull()
    resetAutoApproveStreak('t2')
  })
})
