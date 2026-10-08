import { describe, it, expect, vi, beforeEach } from 'vitest'

const getAgentToolSchemas = vi.fn()
const executeAgentTool = vi.fn()
vi.mock('@/lib/agentTools', () => ({
  getAgentToolSchemas: (...a: unknown[]) => getAgentToolSchemas(...a),
  executeAgentTool: (...a: unknown[]) => executeAgentTool(...a),
}))

let webSearchEnabled = false
vi.mock('@/hooks/useWebSearchConfig', () => ({
  useWebSearchConfig: { getState: () => ({ webSearchEnabled }) },
}))

let visualizeEnabled = false
vi.mock('@/hooks/useVisualizeConfig', () => ({
  useVisualizeConfig: { getState: () => ({ enabled: visualizeEnabled }) },
}))

const directEditAuthorize = vi.fn(async () => 'grant-123')
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  directEditAuthorize: (...a: unknown[]) => directEditAuthorize(...a),
}))

const getTools = vi.fn(async () => [] as unknown[])
const callTool = vi.fn(async () => ({ error: '', content: [{ text: '' }] }))
let trustedServers: string[] = []
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    app: () => ({ getJanDataFolder: async () => '/data' }),
    mcp: () => ({
      getTools,
      callTool,
      trustReport: async () => ({
        trusted: trustedServers.map((name) => ({ name, fingerprint: 'fp', currentFingerprint: 'fp' })),
        invalidated: [],
      }),
    }),
  }),
}))

let disabledTools: string[] = []
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: {
    getState: () => ({
      isToolDisabled: (server: string, tool: string) =>
        disabledTools.includes(`${server}::${tool}`),
    }),
  },
}))

const readSkill = vi.fn(async () => 'SKILL BODY')
vi.mock('@/lib/skillStore', () => ({
  readSkill: (...a: unknown[]) => readSkill(...a),
  storeScope: { kind: 'store' },
}))


import { buildRoomTools, ROOM_READ_TOOLS } from '../roomTools'
import type { RoomToolActivity } from '../types'

const ctx = { roomId: 'r1', folder: '/work', access: 'read' as const }

const schema = (name: string) => ({
  function: {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
})

describe('buildRoomTools', () => {
  beforeEach(() => {
    getAgentToolSchemas.mockReset()
    executeAgentTool.mockReset()
    directEditAuthorize.mockReset()
    directEditAuthorize.mockResolvedValue('grant-123')
    getTools.mockReset()
    getTools.mockResolvedValue([])
    callTool.mockReset()
    callTool.mockResolvedValue({ error: '', content: [{ text: '' }] })
    disabledTools = []
    trustedServers = []
    webSearchEnabled = false
    readSkill.mockReset()
    readSkill.mockResolvedValue('SKILL BODY')
  })

  it('adds a skill_read tool that loads a global skill body on demand', async () => {
    getAgentToolSchemas.mockResolvedValue([])
    const tools = await buildRoomTools(ctx)
    expect(tools.skill_read).toBeDefined()

    const out = await (tools.skill_read as { execute: (i: unknown) => Promise<string> }).execute({
      name: 'caveman',
    })
    expect(out).toBe('SKILL BODY')
    expect(readSkill).toHaveBeenCalledWith({ kind: 'store' }, 'caveman')
  })

  it('offers only the read-only built-ins and drops everything else', async () => {
    getAgentToolSchemas.mockResolvedValue([
      ...ROOM_READ_TOOLS.map(schema),
      schema('bash'),
      schema('write'),
      schema('edit'),
    ])
    const tools = await buildRoomTools(ctx)
    expect(Object.keys(tools).sort()).toEqual([...ROOM_READ_TOOLS, 'skill_read'].sort())
    // Schemas were built for the room's folder.
    expect(getAgentToolSchemas).toHaveBeenCalledWith('/work', undefined, 'thread')
  })

  it('executes against the folder read-only and reports activity', async () => {
    getAgentToolSchemas.mockResolvedValue([schema('read')])
    executeAgentTool.mockResolvedValue({ content: 'FILE BODY' })
    const activity: RoomToolActivity[] = []
    const tools = await buildRoomTools(ctx, (a) => { if (!a.running) activity.push(a) })

    const out = await (tools.read as { execute: (i: unknown) => Promise<string> }).execute({
      path: 'src/main.rs',
    })

    expect(out).toBe('FILE BODY')
    expect(executeAgentTool).toHaveBeenCalledWith('read', { path: 'src/main.rs' }, 'r1', {
      readOnlyProject: '/work',
      scope: 'thread',
    })
    expect(activity).toEqual([
      { name: 'read', ok: true, args: { path: 'src/main.rs' }, output: 'FILE BODY' },
    ])
  })

  it('announces a call before it runs, so the live turn can name it', async () => {
    getAgentToolSchemas.mockResolvedValue([schema('read')])
    executeAgentTool.mockResolvedValue({ content: 'X' })
    const events: RoomToolActivity[] = []
    const tools = await buildRoomTools(ctx, (a) => events.push(a))
    await (tools.read as { execute: (i: unknown) => Promise<string> }).execute({ path: 'a' })
    expect(events[0]).toEqual({ name: 'read', ok: true, args: { path: 'a' }, running: true })
    expect(events[1].running).toBeUndefined()
  })

  it('surfaces a tool error as text and marks the activity failed', async () => {
    getAgentToolSchemas.mockResolvedValue([schema('grep')])
    executeAgentTool.mockResolvedValue({ error: 'permission denied' })
    const activity: RoomToolActivity[] = []
    const tools = await buildRoomTools(ctx, (a) => { if (!a.running) activity.push(a) })

    const out = await (tools.grep as { execute: (i: unknown) => Promise<string> }).execute({
      pattern: 'x',
    })

    expect(out).toBe('ERROR: permission denied')
    expect(activity).toEqual([
      { name: 'grep', ok: false, args: { pattern: 'x' }, output: 'ERROR: permission denied' },
    ])
  })

  it('adds web tools when web search is on, and works with no folder', async () => {
    webSearchEnabled = true
    const tools = await buildRoomTools({ roomId: 'r1', folder: null, access: 'read' })
    // No folder -> no file schemas fetched, only web tools.
    expect(getAgentToolSchemas).not.toHaveBeenCalled()
    expect(Object.keys(tools).sort()).toEqual(['skill_read', 'web_fetch', 'web_search'])
  })

  it('adds write tools with a folder-confined grant for edit access', async () => {
    getAgentToolSchemas.mockResolvedValue([schema('read'), schema('write'), schema('edit')])
    executeAgentTool.mockResolvedValue({ content: 'ok' })
    const tools = await buildRoomTools({ roomId: 'r1', folder: '/work', access: 'edit' })

    expect(directEditAuthorize).toHaveBeenCalledWith('/data', 'r1', '/work')
    expect(Object.keys(tools).sort()).toEqual(['edit', 'read', 'skill_read', 'write'])

    await (tools.write as { execute: (i: unknown) => Promise<string> }).execute({
      path: 'a.txt',
      content: 'x',
    })
    // Writes carry the grant and are confined to the folder.
    expect(executeAgentTool).toHaveBeenCalledWith(
      'write',
      { path: 'a.txt', content: 'x' },
      'r1',
      { readOnlyProject: '/work', writeGrant: 'grant-123', scope: 'thread' }
    )
  })

  it('withholds write tools when the grant cannot be minted', async () => {
    getAgentToolSchemas.mockResolvedValue([schema('read'), schema('write')])
    directEditAuthorize.mockRejectedValueOnce(new Error('refused'))
    const tools = await buildRoomTools({ roomId: 'r1', folder: '/work', access: 'edit' })
    // Read still works; write is not offered without a grant.
    expect(Object.keys(tools).sort()).toEqual(['read', 'skill_read'])
  })

  it('advertises enabled MCP tools and routes calls through callTool', async () => {
    trustedServers = ['docs']
    getAgentToolSchemas.mockResolvedValue([schema('read')])
    getTools.mockResolvedValue([
      { name: 'search_docs', description: 'search', inputSchema: { type: 'object' }, server: 'docs' },
      { name: 'hidden', description: 'nope', inputSchema: { type: 'object' }, server: 'docs' },
    ])
    disabledTools = ['docs::hidden']
    callTool.mockResolvedValue({ error: '', content: [{ text: 'RESULT A' }, { text: 'RESULT B' }] })
    const activity: RoomToolActivity[] = []
    const tools = await buildRoomTools(ctx, (a) => { if (!a.running) activity.push(a) })

    // The disabled tool is dropped; the enabled one is offered alongside reads.
    expect(Object.keys(tools).sort()).toEqual(['read', 'search_docs', 'skill_read'])

    const out = await (tools.search_docs as { execute: (i: unknown) => Promise<string> }).execute({
      q: 'x',
    })
    expect(out).toBe('RESULT A\nRESULT B')
    expect(callTool).toHaveBeenCalledWith({
      toolName: 'search_docs',
      serverName: 'docs',
      arguments: { q: 'x' },
    })
    expect(activity).toEqual([
      { name: 'search_docs', ok: true, args: { q: 'x' }, output: 'RESULT A\nRESULT B', mcp: true },
    ])
  })

  it('surfaces an MCP tool error and never shadows a built-in of the same name', async () => {
    trustedServers = ['docs']
    getAgentToolSchemas.mockResolvedValue([schema('read')])
    getTools.mockResolvedValue([
      { name: 'read', description: 'mcp read', inputSchema: { type: 'object' }, server: 'docs' },
      { name: 'ask', description: 'ask', inputSchema: { type: 'object' }, server: 'docs' },
    ])
    callTool.mockResolvedValue({ error: 'boom', content: [] })
    const activity: RoomToolActivity[] = []
    const tools = await buildRoomTools(ctx, (a) => { if (!a.running) activity.push(a) })

    // The built-in `read` is kept; MCP does not overwrite it.
    expect((tools.read as { description: string }).description).toBe('read tool')

    const out = await (tools.ask as { execute: (i: unknown) => Promise<string> }).execute({})
    expect(out).toBe('ERROR: boom')
    expect(activity).toEqual([{ name: 'ask', ok: false, args: {}, output: 'ERROR: boom', mcp: true }])
  })

  it('withholds MCP tools from servers the user has not trusted', async () => {
    getAgentToolSchemas.mockResolvedValue([schema('read')])
    getTools.mockResolvedValue([
      { name: 'search_docs', description: 'search', inputSchema: { type: 'object' }, server: 'docs' },
    ])
    // No trusted servers, no allow-all.
    const tools = await buildRoomTools(ctx)
    expect(Object.keys(tools).sort()).toEqual(['read', 'skill_read'])
    expect(tools.search_docs).toBeUndefined()
  })

  it('advertises tools from every trusted server, and only those', async () => {
    trustedServers = ['docs', 'other']
    getAgentToolSchemas.mockResolvedValue([schema('read')])
    getTools.mockResolvedValue([
      { name: 'search_docs', description: 'search', inputSchema: { type: 'object' }, server: 'docs' },
      { name: 'query_db', description: 'db', inputSchema: { type: 'object' }, server: 'other' },
      { name: 'run_cmd', description: 'shell', inputSchema: { type: 'object' }, server: 'shell' },
    ])
    const tools = await buildRoomTools(ctx)
    // 'shell' is not trusted, so its tool is withheld.
    expect(Object.keys(tools).sort()).toEqual(['query_db', 'read', 'search_docs', 'skill_read'])
  })

  it('offers the widget tools when enabled and records the call for the transcript card', async () => {
    visualizeEnabled = true
    try {
      const seen: RoomToolActivity[] = []
      const tools = await buildRoomTools({ roomId: 'r9', folder: null, access: 'read' }, (a) => seen.push(a))
      expect(Object.keys(tools)).toEqual(expect.arrayContaining(['visualize_read_me', 'show_widget']))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = await (tools.show_widget as any).execute({ title: 'T', widget_code: '<p>hi</p>' })
      expect(out).toContain('Widget rendered: T')
      expect(seen.find((a) => !a.running)).toMatchObject({ name: 'show_widget', ok: true, args: { title: 'T' } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bad = await (tools.show_widget as any).execute({ title: 'T' })
      expect(bad).toMatch(/^ERROR: /)
      expect(seen.filter((a) => !a.running).map((a) => a.ok)).toEqual([true, false])
    } finally {
      visualizeEnabled = false
    }
  })
})
