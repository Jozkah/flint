/**
 * A room participant's calls go through the real Cowork dispatcher, so what
 * the user does on the approval card (edit the command, deny with a reason)
 * must reach the room turn exactly as it does in Cowork.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeAgentTool } = vi.hoisted(() => ({ executeAgentTool: vi.fn() }))
vi.mock('@/lib/agentTools', () => ({
  executeAgentTool,
  previewAgentChange: vi.fn(async () => undefined),
  getAgentToolSchemas: async () =>
    ['bash', 'read'].map((name) => ({
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    })),
}))
vi.mock('@janhq/tauri-plugin-agent-tools-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  directEditAuthorize: vi.fn(async () => 'grant-1'),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder: async () => 'C:/data' }) }),
}))

import { buildFullFolderTools } from '../fullTools'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'

type Exec = { execute: (i: unknown, o: unknown) => Promise<unknown> }

const ctx = {
  roomId: 'approval-room',
  folder: 'C:/proj',
  access: 'full' as const,
  participantName: 'Ada',
  participantId: 'p-ada',
}

/** Answer the room's approval prompt the way the card would. */
function answer(decision: boolean, leave: (callId: string) => void) {
  useToolApprovalRequests.setState({
    requestApproval: vi.fn(async (callId: string) => {
      leave(callId)
      return decision
    }) as never,
  })
}

const text = (out: unknown) => (typeof out === 'string' ? out : JSON.stringify(out))

describe('room participant approvals', () => {
  beforeEach(() => {
    executeAgentTool.mockReset().mockResolvedValue({ content: 'ok' })
    useToolApprovalRequests.setState({ editedInputs: {}, refusalReasons: {} })
  })

  it('runs the command the user edited on the card, not the model\'s', async () => {
    answer(true, (id) =>
      useToolApprovalRequests.setState({ editedInputs: { [id]: { command: 'rm -r build' } } })
    )
    const tools = await buildFullFolderTools(ctx)
    await (tools.bash as unknown as Exec).execute({ command: 'rm -rf build' }, { toolCallId: 'room-e1' })
    expect(executeAgentTool).toHaveBeenCalledTimes(1)
    expect(executeAgentTool.mock.calls[0][1]).toMatchObject({ command: 'rm -r build' })
    expect(useToolApprovalRequests.getState().editedInputs['room-e1']).toBeUndefined()
  })

  it('tells the participant the reason the user gave with a deny', async () => {
    answer(false, (id) =>
      useToolApprovalRequests.setState({ refusalReasons: { [id]: 'use the trash instead' } })
    )
    const tools = await buildFullFolderTools(ctx)
    const out = await (tools.bash as unknown as Exec).execute({ command: 'rm -rf /' }, { toolCallId: 'room-d1' })
    expect(executeAgentTool).not.toHaveBeenCalled()
    expect(text(out)).toContain('use the trash instead')
    expect(useToolApprovalRequests.getState().refusalReasons['room-d1']).toBeUndefined()
  })
})
