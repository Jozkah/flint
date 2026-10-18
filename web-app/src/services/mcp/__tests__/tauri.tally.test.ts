import { describe, it, expect, beforeEach } from 'vitest'
import { tallied, isCancelledCall } from '../tauri'
import { useEngineActivity } from '@/stores/engine-activity-store'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('MCP call stats (D8)', () => {
  beforeEach(() => useEngineActivity.setState({ toolCalls: [] }))

  it('does not count a call the user cancelled as failed', async () => {
    const cancelled = Promise.reject(new Error("Tool call 'slow_job' was cancelled"))
    await tallied({ toolName: 'slow_job', serverName: 'd' }, cancelled).catch(() => {})
    await flush()
    expect(useEngineActivity.getState().toolCalls).toEqual([])
  })

  it('still counts a real failure and a success', async () => {
    await tallied({ toolName: 't', serverName: 'd' }, Promise.reject(new Error('boom'))).catch(() => {})
    await tallied({ toolName: 't', serverName: 'd' }, Promise.resolve({ error: '' }))
    await flush()
    expect(useEngineActivity.getState().toolCalls.map((c) => c.ok)).toEqual([false, true])
  })

  it('recognises only the backend cancellation message', () => {
    expect(isCancelledCall("Tool call 'x' was cancelled")).toBe(true)
    expect(isCancelledCall('the server was cancelled by its admin and crashed')).toBe(false)
  })
})
