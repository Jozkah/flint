/**
 * In plain chat the browser tools ask the user themselves. The question must be
 * keyed by the tool card's own call id (what ThreadConversation hands over via
 * `browserCallOptions`), or the card shows "waiting for approval" with nothing
 * to press. These run against the real approval store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const browser = vi.fn()
const validated = { status: 'ok', content: '', url: 'https://shop.test/cart', label: 'Checkout' }
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, a?: { request?: { validate_only?: boolean } }) =>
    cmd !== 'browser_agent_call' ? undefined : a?.request?.validate_only ? validated : browser(cmd, a),
}))

import { browserCallOptions, runBrowserAgentTool } from '@/lib/browserAgent'
import { allApprovalRequests, useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'

const pending = () => allApprovalRequests(useToolApprovalRequests.getState())

beforeEach(() => {
  browser.mockReset()
  browser.mockResolvedValue({ status: 'ok', content: 'done' })
  useToolApprovalRequests.setState({ pending: {}, queued: {}, refusals: {} })
  useAgentToolsConfig.setState({ browserAgentEnabled: true })
})

describe('a browser click in plain chat', () => {
  it('raises a request under the tool card, which Allow answers', async () => {
    const options = browserCallOptions('browser_click', 'toolcall-abc')
    const result = runBrowserAgentTool('browser_click', { id: '1.2' }, 'thread-1', options)
    await vi.waitFor(() => expect(pending()).toHaveLength(1))
    const [req] = pending()
    // The card renders its buttons for `pending[its own toolCallId]`.
    expect(useToolApprovalRequests.getState().pending['toolcall-abc']).toBe(req)
    expect(req).toMatchObject({ toolName: 'browser_click', threadId: 'thread-1' })
    expect(req.input).toMatchObject({ id: '1.2', control: 'Checkout', page: 'https://shop.test/cart' })

    useToolApprovalRequests.getState().resolveApproval('toolcall-abc', 'allow-once', req.requestId)
    expect(await result).toEqual({ content: 'done' })
    expect(pending()).toHaveLength(0)
  })

  it('Deny answers it and nothing is clicked', async () => {
    const result = runBrowserAgentTool(
      'browser_click',
      { id: '1.2' },
      'thread-1',
      browserCallOptions('browser_click', 'toolcall-def')
    )
    await vi.waitFor(() => expect(pending()).toHaveLength(1))
    useToolApprovalRequests.getState().resolveApproval('toolcall-def', 'deny', pending()[0].requestId)
    expect(await result).toEqual({ error: expect.stringContaining('declined') })
    expect(browser).not.toHaveBeenCalled()
  })

  it('without the card id the question could not be found under any card (the bug)', async () => {
    const result = runBrowserAgentTool('browser_click', { id: '1.2' }, 'thread-1', {})
    await vi.waitFor(() => expect(pending()).toHaveLength(1))
    expect(useToolApprovalRequests.getState().pending['toolcall-abc']).toBeUndefined()
    expect(pending()[0].toolCallId).toMatch(/^browser_click-/)
    useToolApprovalRequests.getState().resolveApproval(pending()[0].toolCallId, 'deny', pending()[0].requestId)
    await result
  })
})
