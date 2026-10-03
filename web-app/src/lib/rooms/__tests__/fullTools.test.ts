import { beforeEach, describe, expect, it, vi } from 'vitest'

const dispatch = vi.hoisted(() => vi.fn())
const createSurfaceDelegation = vi.hoisted(() => vi.fn())
const delegationOn = vi.hoisted(() => ({ value: true }))
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

vi.mock('@/lib/surfaceDelegation', () => ({ createSurfaceDelegation }))
vi.mock('@/lib/chatDelegation', () => ({ chatDelegationEnabled: () => delegationOn.value }))

import { buildFullFolderTools, ROOM_CHILD_MAX_STEPS, type RoomDelegation } from '../fullTools'

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
  createSurfaceDelegation.mockReset()
  delegationOn.value = true
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

describe('delegation in a room', () => {
  const run = vi.fn()
  const delegation: RoomDelegation = {
    model: () => ({}) as never,
    modelId: 'qwen',
    providerOptions: () => undefined,
    turnId: 't1',
    onUsage: vi.fn(),
  }
  beforeEach(() => {
    run.mockReset().mockResolvedValue({ output: 'child answer' })
    createSurfaceDelegation.mockResolvedValue({ tools: { task: { description: 'task tool' } }, tasks: {}, run })
  })

  it('offers the foreground task to a full-access participant, and nothing else of the family', async () => {
    const tools = await buildFullFolderTools({ ...ctx, tokenBudget: 50_000 }, undefined, delegation)
    expect(Object.keys(tools)).toContain('task')
    expect(Object.keys(tools)).not.toContain('await_task')
    const spec = createSurfaceDelegation.mock.calls[0][0]
    expect(spec).toMatchObject({
      id: 'r1',
      background: false,
      scope: 'session',
      maxSteps: ROOM_CHILD_MAX_STEPS,
      folders: ['C:/proj', 'C:/other'],
      asker: 'Ada',
    })
  })

  it('does not offer it without delegation deps, with the setting off, or with no budget left', async () => {
    expect(Object.keys(await buildFullFolderTools(ctx))).not.toContain('task')
    delegationOn.value = false
    expect(Object.keys(await buildFullFolderTools(ctx, undefined, delegation))).not.toContain('task')
    delegationOn.value = true
    expect(Object.keys(await buildFullFolderTools({ ...ctx, tokenBudget: 0 }, undefined, delegation))).not.toContain('task')
    expect(createSurfaceDelegation).not.toHaveBeenCalled()
  })

  it('holds a child to the tokens the room has left', async () => {
    await buildFullFolderTools({ ...ctx, tokenBudget: 80_000 }, undefined, delegation)
    const { startingTokens } = createSurfaceDelegation.mock.calls[0][0]
    // The child's own cap is 200k; it starts having "spent" what the room lacks.
    expect(startingTokens()).toBe(120_000)
    await buildFullFolderTools({ ...ctx, tokenBudget: 900_000 }, undefined, delegation)
    expect(createSurfaceDelegation.mock.calls[1][0].startingTokens()).toBe(0)
  })

  it('runs the call through the shared delegation and reports it as room activity', async () => {
    const activity = vi.fn()
    const tools = await buildFullFolderTools({ ...ctx, tokenBudget: 1000 }, activity, delegation)
    const out = await (tools.task as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(
      { subagent_name: 'explorer', description: 'look' },
      { toolCallId: 'c9' }
    )
    expect(out).toBe('child answer')
    expect(run.mock.calls[0][0]).toMatchObject({ toolCallId: 'c9', toolName: 'task' })
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ name: 'task', ok: true }))
  })

  it('reports a failed child as an error the model can read', async () => {
    run.mockResolvedValue({ output: 'stopped after 10 steps', isError: true })
    const tools = await buildFullFolderTools({ ...ctx, tokenBudget: 1000 }, undefined, delegation)
    const out = await (tools.task as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }).execute({}, {})
    expect(out).toBe('ERROR: stopped after 10 steps')
  })

  it('offers it to no one without a folder', async () => {
    expect(await buildFullFolderTools({ ...ctx, folder: null }, undefined, delegation)).toEqual({})
  })
})
