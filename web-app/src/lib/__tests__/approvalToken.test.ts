import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }))

import { executeTool } from '../../../../src-tauri/plugins/tauri-plugin-agent-tools/guest-js/index'

describe('executeTool approval tokens (O02-024)', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'plugin:agent-tools|approval_mint' ? 'appr-x' : { content: '' }
    )
  })

  it('mints a token for this exact call before a prompted approval', async () => {
    const args = { path: 'a' }
    await executeTool('/d', 't1', 'write', args, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'prompted')
    expect(invoke.mock.calls[0]).toEqual([
      'plugin:agent-tools|approval_mint',
      { threadId: 't1', callId: undefined, name: 'write', args, approval: 'prompted' },
    ])
    expect(invoke.mock.calls[1][0]).toBe('plugin:agent-tools|execute_tool')
    expect(invoke.mock.calls[1][1]).toMatchObject({ approval: 'prompted', approvalToken: 'appr-x' })
  })

  it('mints nothing for auto or no approval', async () => {
    await executeTool('/d', 't1', 'read', {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'auto')
    await executeTool('/d', 't1', 'read', {})
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      'plugin:agent-tools|execute_tool',
      'plugin:agent-tools|execute_tool',
    ])
    expect(invoke.mock.calls[0][1].approvalToken).toBeUndefined()
  })
})
