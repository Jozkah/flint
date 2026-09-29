import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@janhq/tauri-plugin-agent-tools-api'
import {
  COWORK_BASH_FOREGROUND_TIMEOUT_MAX,
  coworkToolsFromSchemas,
} from '../coworkTools'

const bashSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a command.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'integer', description: 'Seconds to wait.' },
        background: { type: 'boolean' },
      },
      required: [],
    },
  },
}

describe('Cowork bash timeout contract', () => {
  it('does not advertise a timeout longer than the 120 second lifecycle watchdog', () => {
    const tools = coworkToolsFromSchemas([bashSchema], {
      planMode: false,
      webSearch: false,
      allowSubagents: false,
      subagentNames: [],
    })

    const encoded = JSON.stringify(tools.bash.inputSchema)
    expect(encoded).toContain(`"maximum":${COWORK_BASH_FOREGROUND_TIMEOUT_MAX}`)
    expect(tools.bash.description).toContain('background:true')
    expect(tools.bash.description).toContain('at most 120 seconds')
  })
})
