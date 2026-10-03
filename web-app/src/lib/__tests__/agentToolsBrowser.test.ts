import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeTool = vi.fn()
const firePostToolBatch = vi.fn()
const threadWorkspaceDelete = vi.fn()
const getJanDataFolder = vi.fn()
const invoke = vi.fn()

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  advertisedToolSchemas: vi.fn(),
  executeTool: (...a: unknown[]) => executeTool(...a),
  executeToolStreaming: vi.fn(),
  firePostToolBatch: (...a: unknown[]) => firePostToolBatch(...a),
  threadWorkspaceDelete: (...a: unknown[]) => threadWorkspaceDelete(...a),
  threadWorkspaceSweep: vi.fn(),
  sandboxStatus: vi.fn(),
  sandboxToolchains: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  Channel: class {},
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder }) }),
}))
vi.mock('@/hooks/useToolApprovalRequests', () => ({
  approvalSourceFor: () => 'prompted',
  useToolApprovalRequests: { getState: () => ({ requestApproval: vi.fn() }) },
}))

import { cleanupThreadWorkspace, executeAgentTool, notifyToolBatch } from '../agentTools'
import { forgetToolScreenshots, getToolScreenshot, SCREENSHOT_RESULT_NOTE } from '../toolScreenshots'

const shot = 'data:image/jpeg;base64,AAAA'

describe('browser tool results and run-end wiring', () => {
  beforeEach(() => {
    executeTool.mockReset()
    firePostToolBatch.mockReset().mockResolvedValue(undefined)
    threadWorkspaceDelete.mockReset().mockResolvedValue(undefined)
    getJanDataFolder.mockReset().mockResolvedValue('/data')
    invoke.mockReset().mockResolvedValue(0)
    forgetToolScreenshots()
  })

  it('keeps a browser screenshot beside the transcript and says so in the text result', async () => {
    executeTool.mockResolvedValue({
      content: 'Screenshot of http://127.0.0.1:1/ (viewport).',
      diff: null,
      isError: false,
      images: [{ dataUrl: shot, name: 'browser-screenshot.jpg' }],
    })
    const r = await executeAgentTool(
      'browser',
      { action: 'screenshot' },
      't1',
      // Reads need no question, so no approval is involved.
      { callId: 'call-9' }
    )
    expect(r.content).toContain('Screenshot of http://127.0.0.1:1/')
    expect(r.content).toContain(SCREENSHOT_RESULT_NOTE)
    expect(getToolScreenshot('call-9')).toBe(shot)
    // The stored result is text: no picture inside it.
    expect(JSON.stringify(r)).not.toContain('base64')
  })

  it('does not touch the result of any other tool, even one that returns images', async () => {
    executeTool.mockResolvedValue({
      content: 'file contents',
      diff: null,
      isError: false,
      images: [{ dataUrl: shot, name: 'x.jpg' }],
    })
    const r = await executeAgentTool('read', { path: 'a' }, 't1', { callId: 'call-1' })
    expect(r.content).toBe('file contents')
    expect(getToolScreenshot('call-1')).toBeUndefined()
  })

  it('says nothing about a picture when the call failed or has no id to keep it under', async () => {
    executeTool.mockResolvedValue({ content: 'ERROR: no page', diff: null, isError: true, images: [{ dataUrl: shot, name: 'x' }] })
    const failed = await executeAgentTool('browser', { action: 'screenshot' }, 't1', { callId: 'c' })
    expect(failed.error).toBe('ERROR: no page')
    expect(getToolScreenshot('c')).toBeUndefined()
    // A picture that is not a bounded image data URL is not kept, and not promised.
    executeTool.mockResolvedValue({ content: 'ok', diff: null, isError: false, images: [{ dataUrl: 'https://x/y.png', name: 'x' }] })
    const bad = await executeAgentTool('browser', { action: 'screenshot' }, 't1', { callId: 'c2' })
    expect(bad.content).toBe('ok')
    expect(getToolScreenshot('c2')).toBeUndefined()
  })

  it('tells the batch hooks whose turn it was', async () => {
    notifyToolBatch('s1', ['read'], 'session', 'subagent')
    notifyToolBatch('s1', ['read'], 'session')
    notifyToolBatch('t1', ['bash'])
    await vi.waitFor(() => expect(firePostToolBatch).toHaveBeenCalledTimes(3))
    const agents = firePostToolBatch.mock.calls.map((c) => c[5])
    expect(agents).toEqual(['subagent', 'main', 'main'])
  })

  it('ends a deleted thread’s agent browser with its workspace', async () => {
    await cleanupThreadWorkspace('t-del')
    expect(invoke).toHaveBeenCalledWith('browser_tool_close', { id: 't-del' })
    expect(threadWorkspaceDelete).toHaveBeenCalledWith('/data', 't-del')
  })
})
