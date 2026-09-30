import { beforeEach, describe, expect, it, vi } from 'vitest'

const dispatch = vi.hoisted(() => vi.fn())
const authorize = vi.hoisted(() => vi.fn())

vi.mock('@/lib/coworkDispatch', () => ({ dispatchCoworkTool: dispatch }))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({ directEditAuthorize: authorize }))
vi.mock('@/lib/agentTools', () => ({
  getAgentToolSchemas: async () =>
    [
      'bash',
      'read',
      'write',
      'git',
      'skill_read',
      'list_plugins',
      'memory_write',
      'skill_write',
      'request_access',
      'send_message',
    ].map((name) => ({ function: { name, description: name, parameters: { type: 'object', properties: {} } } })),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder: async () => 'C:/data' }) }),
}))
vi.mock('@/hooks/useWebSearchConfig', () => ({
  useWebSearchConfig: { getState: () => ({ webSearchEnabled: false }) },
}))
vi.mock('@/hooks/useToolApprovalRequests', () => ({
  useToolApprovalRequests: { getState: () => ({ requestApproval: vi.fn().mockResolvedValue(true) }) },
}))

import { buildFullFolderTools } from '../fullTools'

const ctx = {
  roomId: 'r1',
  folder: 'C:/proj',
  extraFolders: ['C:/other'],
  access: 'full' as const,
  participantName: 'Ada',
}

beforeEach(() => {
  dispatch.mockReset()
  authorize.mockReset().mockResolvedValue('grant-1')
})

describe('buildFullFolderTools', () => {
  it('offers the shell, git, files, skills and plugins, and withholds the rest', async () => {
    const tools = await buildFullFolderTools(ctx)
    expect(Object.keys(tools).sort()).toEqual(['bash', 'git', 'list_plugins', 'read', 'skill_read', 'write'])
  })

  it('covers every attached folder with one write grant', async () => {
    await buildFullFolderTools(ctx)
    expect(authorize).toHaveBeenCalledWith('C:/data', 'r1', 'C:/proj', ['C:/other'])
  })

  it('sends each call through the Cowork dispatcher in ask mode, as the speaking participant', async () => {
    dispatch.mockResolvedValue({ output: 'done', isError: false })
    const tools = await buildFullFolderTools(ctx)
    const out = await (tools.bash as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(
      { command: 'ls' },
      { toolCallId: 'c1' }
    )
    expect(out).toBe('done')
    const [call, dctx] = dispatch.mock.calls[0]
    expect(call).toMatchObject({ toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } })
    expect(dctx).toMatchObject({
      sessionId: 'r1',
      mode: 'ask',
      access: 'edit-folder',
      writeGrant: 'grant-1',
      extraFolders: ['C:/other'],
    })
    expect(dctx.activity.agent).toBe('Ada')
  })

  it('reports a refused call as an error the model can read', async () => {
    dispatch.mockResolvedValue({ output: 'The user did not allow `bash`.', isError: true })
    const tools = await buildFullFolderTools(ctx)
    const out = await (tools.bash as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }).execute({}, {})
    expect(out).toBe('ERROR: The user did not allow `bash`.')
  })

  it('falls back to reading and sandboxed commands when no write grant can be made', async () => {
    authorize.mockRejectedValue(new Error('no'))
    dispatch.mockResolvedValue({ output: 'ok' })
    const tools = await buildFullFolderTools(ctx)
    await (tools.read as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }).execute({}, {})
    expect(dispatch.mock.calls[0][1]).toMatchObject({ access: 'review-only' })
  })

  it('has no tools without a folder', async () => {
    expect(await buildFullFolderTools({ ...ctx, folder: null })).toEqual({})
  })
})
