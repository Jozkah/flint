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
    webSearchEnabled = false
  })

  it('offers only the read-only built-ins and drops everything else', async () => {
    getAgentToolSchemas.mockResolvedValue([
      ...ROOM_READ_TOOLS.map(schema),
      schema('bash'),
      schema('write'),
      schema('edit'),
    ])
    const tools = await buildRoomTools(ctx)
    expect(Object.keys(tools).sort()).toEqual([...ROOM_READ_TOOLS].sort())
    // Schemas were built for the room's folder.
    expect(getAgentToolSchemas).toHaveBeenCalledWith('/work', undefined, 'thread')
  })

  it('executes against the folder read-only and reports activity', async () => {
    getAgentToolSchemas.mockResolvedValue([schema('read')])
    executeAgentTool.mockResolvedValue({ content: 'FILE BODY' })
    const activity: RoomToolActivity[] = []
    const tools = await buildRoomTools(ctx, (a) => activity.push(a))

    const out = await (tools.read as { execute: (i: unknown) => Promise<string> }).execute({
      path: 'src/main.rs',
    })

    expect(out).toBe('FILE BODY')
    expect(executeAgentTool).toHaveBeenCalledWith('read', { path: 'src/main.rs' }, 'r1', {
      readOnlyProject: '/work',
      scope: 'thread',
    })
    expect(activity).toEqual([{ name: 'read', ok: true }])
  })

  it('surfaces a tool error as text and marks the activity failed', async () => {
    getAgentToolSchemas.mockResolvedValue([schema('grep')])
    executeAgentTool.mockResolvedValue({ error: 'permission denied' })
    const activity: RoomToolActivity[] = []
    const tools = await buildRoomTools(ctx, (a) => activity.push(a))

    const out = await (tools.grep as { execute: (i: unknown) => Promise<string> }).execute({
      pattern: 'x',
    })

    expect(out).toBe('ERROR: permission denied')
    expect(activity).toEqual([{ name: 'grep', ok: false }])
  })

  it('adds web tools when web search is on, and works with no folder', async () => {
    webSearchEnabled = true
    const tools = await buildRoomTools({ roomId: 'r1', folder: null, access: 'read' })
    // No folder -> no file schemas fetched, only web tools.
    expect(getAgentToolSchemas).not.toHaveBeenCalled()
    expect(Object.keys(tools).sort()).toEqual(['web_fetch', 'web_search'])
  })
})
