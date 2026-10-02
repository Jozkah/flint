/**
 * Browser tools inside a Cowork session: the question reaches the same
 * approval store Cowork's UI renders (the tool card, the header's approvals
 * chip, a subagent's child-approvals panel), Deny and Stop withdraw it, and the
 * domain question goes to the one global dialog's store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Only the browser command is scripted; the activity recorder and friends also
// call invoke and must not eat scripted answers.
const browser = vi.fn()
// The check that runs before the user is asked (node id and site) answers itself.
const validated = { status: 'ok', content: '', url: 'https://shop.test/cart?id=7', label: 'Add to cart' }
const invoke = vi.fn(async (cmd: string, ...rest: unknown[]) => {
  if (cmd !== 'browser_agent_call') return undefined
  const req = (rest[0] as { request: { validate_only?: boolean } }).request
  return req.validate_only ? validated : browser(cmd, ...rest)
})
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: [string, ...unknown[]]) => invoke(...a),
}))

import { dispatchCoworkTool } from '../coworkDispatch'
import type { PendingToolCall } from '../coworkRunner'
import type { CoworkMode } from '../coworkMode'
import { allApprovalRequests, useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useBrowserAgentPrompt } from '@/hooks/useBrowserAgentPrompt'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { useWebPreview } from '@/hooks/useWebPreview'

const SID = 'session-1'

const call = (toolName: string, input: unknown = {}): PendingToolCall => ({
  toolCallId: 'call-1',
  toolName,
  input,
})

/** Exactly what routes/cowork.tsx hands the dispatcher. */
const onApprove = (origin?: string) =>
  vi.fn(
    (
      callId: string,
      toolName: string,
      input: unknown,
      preview?: string,
      signal?: AbortSignal,
      forced?: { alwaysAsk: true; reason: string }
    ) =>
      useToolApprovalRequests
        .getState()
        .requestApproval(callId, toolName, SID, undefined, {
          input,
          ...(forced ? { alwaysAsk: true, taskContext: forced.reason } : {}),
          preview,
          ...(origin ? { origin } : {}),
          signal,
        })
  )

const ctx = (over: Record<string, unknown> = {}) => ({
  sessionId: SID,
  readOnlyFolder: null,
  mode: 'ask' as CoworkMode,
  webSearch: false,
  onTodo: vi.fn(async () => ({ output: '' })),
  onAsk: vi.fn(async () => ({ output: '' })),
  onTask: vi.fn(async () => ({ output: '' })),
  onApprove: onApprove(),
  ...over,
})

const ok = {
  status: 'ok',
  content: '<untrusted_web_content id=a kind=status url="https://shop.test/">done</untrusted_web_content id=a>',
}

const pendingList = () =>
  allApprovalRequests(useToolApprovalRequests.getState())

beforeEach(() => {
  browser.mockReset()
  browser.mockResolvedValue(ok)
  useToolApprovalRequests.setState({ pending: {}, queued: {}, refusals: {} })
  useBrowserAgentPrompt.setState({ queue: [] })
  useAgentToolsConfig.setState({ browserAgentEnabled: true, browserAgentMaxActions: 40 })
  useWebPreview.setState({ open: true, surface: 'side', history: ['https://shop.test/cart?id=7'], index: 0 })
})

describe('a browser action in a Cowork session', () => {
  it('produces a visible approval request, and nothing runs until it is answered', async () => {
    const pending = dispatchCoworkTool(call('browser_click', { id: '1.2' }), ctx())
    await vi.waitFor(() => expect(pendingList()).toHaveLength(1))
    const [req] = pendingList()
    // Keyed the way the tool card, the header chip and the remote bridge read it.
    expect(req).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'browser_click',
      threadId: SID,
      input: { id: '1.2' },
    })
    expect(req.preview).toContain('https://shop.test/cart?id=7')
    expect(browser).not.toHaveBeenCalled()

    useToolApprovalRequests.getState().resolveApproval('call-1', 'allow-once', req.requestId)
    const out = await pending
    expect(out.isError).toBeFalsy()
    expect(browser.mock.calls[0][1].request).toMatchObject({ tool: 'click', unattended: false })
    expect(pendingList()).toHaveLength(0)
  })

  it('Deny withdraws the request and the page is never touched', async () => {
    const pending = dispatchCoworkTool(call('browser_click', { id: '1.2' }), ctx())
    await vi.waitFor(() => expect(pendingList()).toHaveLength(1))
    useToolApprovalRequests.getState().resolveApproval('call-1', 'deny', pendingList()[0].requestId)
    const out = await pending
    expect(out.isError).toBe(true)
    expect(out.output).toContain('declined')
    expect(pendingList()).toHaveLength(0)
    expect(browser).not.toHaveBeenCalled()
  })

  it('stopping the run withdraws the open request', async () => {
    const stop = new AbortController()
    const pending = dispatchCoworkTool(call('browser_type', { id: '1.2', text: 'x' }), ctx(), stop.signal)
    await vi.waitFor(() => expect(pendingList()).toHaveLength(1))
    stop.abort()
    const out = await pending
    expect(out.isError).toBe(true)
    await vi.waitFor(() => expect(pendingList()).toHaveLength(0))
    expect(browser).not.toHaveBeenCalled()
  })

  it('a submit-like control asks a second, always-ask question naming the control', async () => {
    browser
      .mockResolvedValueOnce({ status: 'needs_confirmation', label: 'Pay', reason: 'it submits a form', url: 'https://shop.test/pay?t=1' })
      .mockResolvedValueOnce(ok)
    const pending = dispatchCoworkTool(call('browser_click', { id: '1.9' }), ctx())
    await vi.waitFor(() => expect(pendingList()).toHaveLength(1))
    useToolApprovalRequests.getState().resolveApproval('call-1', 'allow-once', pendingList()[0].requestId)
    await vi.waitFor(() => expect(pendingList().some((r) => r.alwaysAsk)).toBe(true))
    const second = pendingList()[0]
    expect(second.taskContext).toContain('Pay')
    expect(second.taskContext).toContain('https://shop.test/pay?t=1')
    expect(second.preview).toContain('https://shop.test/pay?t=1')
    useToolApprovalRequests.getState().resolveApproval('call-1', 'deny', second.requestId)
    const out = await pending
    expect(out.isError).toBe(true)
    // The confirmed retry was never sent.
    expect(browser).toHaveBeenCalledTimes(1)
  })

  it("a subagent's request is shown on its own, naming the subagent", async () => {
    const pending = dispatchCoworkTool(
      call('browser_click', { id: '1.2' }),
      ctx({ onApprove: onApprove('reviewer') })
    )
    await vi.waitFor(() => expect(pendingList()).toHaveLength(1))
    expect(pendingList()[0].origin).toBe('reviewer')
    useToolApprovalRequests.getState().resolveApproval('call-1', 'deny', pendingList()[0].requestId)
    await pending
  })

  it('without a way to ask, the action is refused rather than run', async () => {
    const out = await dispatchCoworkTool(
      call('browser_click', { id: '1.2' }),
      ctx({ onApprove: undefined })
    )
    expect(out.isError).toBe(true)
    expect(browser).not.toHaveBeenCalled()
  })

  it('review mode refuses it outright', async () => {
    const out = await dispatchCoworkTool(call('browser_click', { id: '1.2' }), ctx({ mode: 'review' }))
    expect(out.isError).toBe(true)
    expect(out.output).toContain('review mode')
    expect(pendingList()).toHaveLength(0)
    expect(browser).not.toHaveBeenCalled()
  })

  it('auto mode asks nobody: the run is unattended and the backend decides', async () => {
    const out = await dispatchCoworkTool(call('browser_click', { id: '1.2' }), ctx({ mode: 'auto' }))
    expect(pendingList()).toHaveLength(0)
    expect(browser.mock.calls[0][1].request.unattended).toBe(true)
    expect(out.isError).toBeFalsy()
  })
})

describe('the first-visit question in Cowork', () => {
  it('goes to the one global dialog store, with the whole address', async () => {
    browser.mockResolvedValueOnce({ status: 'needs_permission', host: 'docs.test', url: 'https://docs.test/a?q=1' }).mockResolvedValue(ok)
    const pending = dispatchCoworkTool(call('browser_open', { url: 'https://docs.test/a?q=1' }), ctx())
    await vi.waitFor(() => expect(useBrowserAgentPrompt.getState().queue).toHaveLength(1))
    const q = useBrowserAgentPrompt.getState().queue[0]
    expect(q).toMatchObject({ host: 'docs.test', url: 'https://docs.test/a?q=1', tool: 'browser_open' })
    useBrowserAgentPrompt.getState().answer(q.id, { decision: 'deny', scope: 'once', subdomains: false })
    const out = await pending
    expect(out.isError).toBe(true)
  })

  it('stopping the run withdraws the domain question', async () => {
    browser.mockResolvedValue({ status: 'needs_permission', host: 'docs.test', url: 'https://docs.test/' })
    const stop = new AbortController()
    const pending = dispatchCoworkTool(call('browser_open', { url: 'https://docs.test/' }), ctx(), stop.signal)
    await vi.waitFor(() => expect(useBrowserAgentPrompt.getState().queue).toHaveLength(1))
    stop.abort()
    await pending
    await vi.waitFor(() => expect(useBrowserAgentPrompt.getState().queue).toHaveLength(0))
  })
})
