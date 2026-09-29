import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAgentToolSchemas: vi.fn(),
}))

vi.mock('@/lib/agentTools', () => ({
  getAgentToolSchemas: mocks.getAgentToolSchemas,
}))

import { buildCoworkTools } from '../coworkTools'
import type { ToolSchema } from '@janhq/tauri-plugin-agent-tools-api'

const schema = (name: string): ToolSchema =>
  ({
    type: 'function',
    function: {
      name,
      description: `${name} description long enough for the test`,
      parameters: { type: 'object', properties: {}, required: [] },
    },
  }) as ToolSchema

const base = {
  planMode: false,
  subagentNames: [],
  allowSubagents: false,
  webSearch: false,
}

describe('Cowork project-scoped messaging tools', () => {
  beforeEach(() => {
    mocks.getAgentToolSchemas.mockReset()
    mocks.getAgentToolSchemas.mockResolvedValue([
      schema('read'),
      schema('list_sessions'),
      schema('send_message'),
      schema('read_messages'),
      schema('wait_for_reply'),
      schema('stop_session'),
    ])
  })

  it('does not advertise guaranteed no_project calls without an attached project', async () => {
    const tools = await buildCoworkTools(base)

    expect(tools.read).toBeDefined()
    for (const name of [
      'list_sessions',
      'send_message',
      'read_messages',
      'wait_for_reply',
      'stop_session',
    ]) {
      expect(tools[name]).toBeUndefined()
    }
  })

  it('advertises session messaging when the Cowork run has a project identity', async () => {
    const tools = await buildCoworkTools({ ...base, projectRoot: 'C:/repo' })

    expect(tools.list_sessions).toBeDefined()
    expect(tools.send_message).toBeDefined()
    expect(tools.read_messages).toBeDefined()
    expect(tools.wait_for_reply).toBeDefined()
    expect(tools.stop_session).toBeDefined()
  })
})
