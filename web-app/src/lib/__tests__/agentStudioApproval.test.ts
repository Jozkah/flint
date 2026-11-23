import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeTool = vi.fn()
const executeToolStreaming = vi.fn()
const status = vi.fn()
const gallery = vi.fn()
const generateImage = vi.fn()
const openExternal = vi.fn()

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  advertisedToolSchemas: vi.fn(),
  executeTool: (...args: unknown[]) => executeTool(...args),
  executeToolStreaming: (...args: unknown[]) => executeToolStreaming(...args),
  threadWorkspaceDelete: vi.fn(),
  threadWorkspaceSweep: vi.fn(),
  sandboxStatus: vi.fn(),
  sandboxToolchains: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (m: unknown) => void = () => {}
  },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder: async () => '/data' }) }),
}))
vi.mock('@/lib/studio/studio', () => ({
  studioApi: {
    status: () => status(),
    gallery: (k: string) => gallery(k),
    generateImage: (p: unknown) => generateImage(p),
    cancel: vi.fn(),
    openExternal: (...a: unknown[]) => openExternal(...a),
    media: vi.fn(),
  },
}))
vi.mock('@/hooks/useStudio', () => ({
  useStudio: { getState: () => ({ refreshGallery: vi.fn() }) },
}))

const model = {
  id: 'z-image-turbo',
  display_name: 'Z-Image Turbo',
  kind: 'image',
  installed: true,
  min_side: 256,
  max_side: 1536,
  defaults: { steps: 8, width: 1024, height: 1024 },
}
const ready = { supported: true, engineBackend: 'vulkan', models: [model], resident: null }
const picture = {
  id: 'g1',
  kind: 'image',
  path: 'C:\\Data\\images\\g1.png',
  recipe: {
    prompt: 'a fox',
    negativePrompt: '',
    width: 1024,
    height: 1024,
    steps: 8,
    seed: 1,
    modelId: 'z-image-turbo',
    modelName: 'Z-Image Turbo',
    createdAtMs: 5,
  },
}

describe('Studio tools and the consent model', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
    status.mockResolvedValue(ready)
    gallery.mockResolvedValue([picture])
    executeTool.mockResolvedValue({ content: 'ok', isError: false })
    generateImage.mockResolvedValue({
      job_id: 'j',
      seed: 1,
      ids: ['g1'],
      paths: [picture.path],
      duration_ms: 1,
    })
  })

  it('asks before generating, as it does for the other tools that act on this computer', async () => {
    const { HOST_ASKED } = await import('../hostAsked')
    expect(HOST_ASKED.has('studio_generate_image')).toBe(true)
    expect(HOST_ASKED.has('studio_open_in_editor')).toBe(true)
    // Listing only reads.
    expect(HOST_ASKED.has('studio_list_generations')).toBe(false)

    const { executeAgentTool } = await import('../agentTools')
    const { useToolApprovalRequests } = await import('@/hooks/useToolApprovalRequests')
    const run = executeAgentTool('studio_generate_image', { prompt: 'a fox' }, 'chat-1', {
      callId: 'call-gen',
    })
    await vi.waitFor(() =>
      expect(useToolApprovalRequests.getState().pending['call-gen']).toBeDefined()
    )
    // Not started while the question is open.
    expect(generateImage).not.toHaveBeenCalled()
    const asked = useToolApprovalRequests.getState().pending['call-gen']
    expect(asked.alwaysAsk).toBe(true)
    expect(asked.taskContext).toContain('a fox')
    asked.resolve(true)
    const result = await run
    expect(result.error).toBeUndefined()
    expect(JSON.parse(result.content ?? '{}').status).toBe('done')
    expect(generateImage).toHaveBeenCalledTimes(1)
  })

  it('does not generate when the user declines', async () => {
    const { executeAgentTool } = await import('../agentTools')
    const { useToolApprovalRequests } = await import('@/hooks/useToolApprovalRequests')
    const run = executeAgentTool('studio_generate_image', { prompt: 'a fox' }, 'chat-2', {
      callId: 'call-no',
    })
    await vi.waitFor(() =>
      expect(useToolApprovalRequests.getState().pending['call-no']).toBeDefined()
    )
    useToolApprovalRequests.getState().pending['call-no'].resolve(false)
    expect((await run).error).toMatch(/declined/i)
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('refuses without asking when no model is installed', async () => {
    status.mockResolvedValue({ ...ready, models: [{ ...model, installed: false }] })
    const { executeAgentTool } = await import('../agentTools')
    const { useToolApprovalRequests } = await import('@/hooks/useToolApprovalRequests')
    const result = await executeAgentTool('studio_generate_image', { prompt: 'a fox' }, 'chat-3', {
      callId: 'call-none',
    })
    expect(result.error).toMatch(/install|download or add/i)
    expect(useToolApprovalRequests.getState().pending['call-none']).toBeUndefined()
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('refuses a bad argument without asking', async () => {
    const { executeAgentTool } = await import('../agentTools')
    const { useToolApprovalRequests } = await import('@/hooks/useToolApprovalRequests')
    const result = await executeAgentTool('studio_generate_image', { prompt: 'x', steps: 5000 }, 'chat-4', {
      callId: 'call-bad',
    })
    expect(result.error).toMatch(/steps/)
    expect(useToolApprovalRequests.getState().pending['call-bad']).toBeUndefined()
  })

  it('asks before starting the editor, and not at all when none is set up', async () => {
    const { executeAgentTool } = await import('../agentTools')
    const { useToolApprovalRequests } = await import('@/hooks/useToolApprovalRequests')
    const none = await executeAgentTool('studio_open_in_editor', { id: 'g1' }, 'chat-5', {
      callId: 'call-open-none',
    })
    expect(none.error).toMatch(/No external editor/)
    expect(useToolApprovalRequests.getState().pending['call-open-none']).toBeUndefined()

    window.localStorage.setItem(
      'studio-external-editor',
      JSON.stringify({ preset: 'gmic', program: 'C:\\Tools\\gmic_qt.exe', args: '' })
    )
    openExternal.mockResolvedValue(undefined)
    const run = executeAgentTool('studio_open_in_editor', { id: 'g1' }, 'chat-5', {
      callId: 'call-open',
    })
    await vi.waitFor(() =>
      expect(useToolApprovalRequests.getState().pending['call-open']).toBeDefined()
    )
    expect(openExternal).not.toHaveBeenCalled()
    useToolApprovalRequests.getState().pending['call-open'].resolve(true)
    expect((await run).error).toBeUndefined()
    expect(openExternal).toHaveBeenCalledWith('image', 'g1', 'C:\\Tools\\gmic_qt.exe', '')
  })

  it('refuses an unattended run that nobody can approve', async () => {
    const { executeAgentTool } = await import('../agentTools')
    const result = await executeAgentTool('studio_generate_image', { prompt: 'a fox' }, 'chat-6', {
      callId: 'call-unattended',
      unattended: true,
    })
    expect(result.error).toMatch(/not run/)
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('lists without asking, then hands the file tools the gallery folder read-only, for that chat only', async () => {
    const { executeAgentTool } = await import('../agentTools')
    const listed = await executeAgentTool('studio_list_generations', {}, 'chat-7')
    expect(listed.error).toBeUndefined()
    expect(JSON.parse(listed.content ?? '{}').generations[0].path).toBe(picture.path)

    await executeAgentTool('read', { path: picture.path }, 'chat-7')
    // executeTool(dataFolder, thread, name, args, ..., readOnlyProject, writeGrant, scope, callId, undoRun, actor, extraProjects, approval)
    const extras = (call: unknown[]) => call[13]
    expect(extras(executeTool.mock.calls[0])).toEqual(['C:\\Data\\images'])
    // The first project slot (the user's attached folder) is untouched and no write grant appears.
    expect(executeTool.mock.calls[0][7]).toBeUndefined()

    await executeAgentTool('read', { path: 'x' }, 'chat-other')
    expect(extras(executeTool.mock.calls[1])).toBeUndefined()
  })

  it('keeps the folders the user attached and adds the gallery after them', async () => {
    const { executeAgentTool } = await import('../agentTools')
    await executeAgentTool('studio_list_generations', {}, 'chat-8')
    await executeAgentTool('ls', { path: '.' }, 'chat-8', { extraProjects: ['D:\\Work'] })
    expect(executeTool.mock.calls[0][13]).toEqual(['D:\\Work', 'C:\\Data\\images'])
  })
})
