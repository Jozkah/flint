import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}))

import {
  BROWSER_TOOL_NAMES,
  browserAgentSchemas,
  browserCardUrl,
  isBrowserActionTool,
  patternsFor,
  runBrowserAgentTool,
  urlFromBrowserOutput,
} from '@/lib/browserAgent'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { useBrowserAgentPrompt } from '@/hooks/useBrowserAgentPrompt'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'

const approve = vi.fn()

beforeEach(() => {
  invoke.mockReset()
  approve.mockReset()
  approve.mockResolvedValue(true)
  useToolApprovalRequests.setState({ requestApproval: approve })
  useBrowserAgentPrompt.setState({ queue: [] })
  useAgentToolsConfig.setState({
    browserAgentEnabled: true,
    browserAgentMaxActions: 40,
  })
})

/** Answer the next domain question once it is on screen. */
async function answerNext(
  decision: 'allow' | 'deny' | 'never',
  scope: 'once' | 'session' | 'always' = 'once',
  subdomains = false
) {
  await vi.waitFor(() =>
    expect(useBrowserAgentPrompt.getState().queue.length).toBe(1)
  )
  const head = useBrowserAgentPrompt.getState().queue[0]
  useBrowserAgentPrompt
    .getState()
    .answer(head.id, { decision, scope, subdomains })
  return head
}

const ok = {
  status: 'ok',
  content:
    '<untrusted_web_content id=a kind=text url="https://example.com/">x</untrusted_web_content id=a>',
}
const ask = {
  status: 'needs_permission',
  host: 'example.com',
  url: 'https://example.com/a?b=1',
}

describe('switch', () => {
  it('refuses when the agent browser is off, without touching the backend', async () => {
    useAgentToolsConfig.setState({ browserAgentEnabled: false })
    const r = await runBrowserAgentTool('browser_read_text', {}, 't1')
    expect(r).toEqual({ error: expect.stringContaining('turned off') })
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('reading', () => {
  it('passes the request through and returns the fenced content', async () => {
    invoke.mockResolvedValueOnce(ok)
    const r = await runBrowserAgentTool(
      'browser_read_text',
      { max_chars: 900 },
      't1',
      { runId: 'run-1', projectRoot: 'C:/proj' }
    )
    expect(r).toEqual({ content: ok.content })
    expect(invoke).toHaveBeenCalledWith('browser_agent_call', {
      request: expect.objectContaining({
        tool: 'read_text',
        run_id: 'run-1',
        enabled: true,
        unattended: false,
        max_actions: 40,
        project_root: 'C:/proj',
        max_chars: 900,
        confirmed: false,
      }),
    })
    // Reads do not ask for a tool approval; the domain prompt is their gate.
    expect(approve).not.toHaveBeenCalled()
  })

  it('maps each tool to its backend operation', async () => {
    invoke.mockResolvedValue(ok)
    await runBrowserAgentTool(
      'browser_open',
      { url: 'https://example.com' },
      't'
    )
    await runBrowserAgentTool('browser_snapshot', {}, 't')
    const ops = invoke.mock.calls.map((c) => c[1].request.tool)
    expect(ops).toEqual(['open', 'snapshot'])
    expect(invoke.mock.calls[0][1].request.url).toBe('https://example.com')
  })

  it('reports a refusal from the backend as the tool error', async () => {
    invoke.mockResolvedValueOnce({
      status: 'denied',
      reason: 'blocked: internal address',
    })
    expect(
      await runBrowserAgentTool('browser_open', { url: 'http://127.0.0.1/' }, 't')
    ).toEqual({ error: 'blocked: internal address' })
    invoke.mockResolvedValueOnce({
      status: 'paused',
      reason: 'The user took over the browser.',
    })
    expect(await runBrowserAgentTool('browser_snapshot', {}, 't')).toEqual({
      error: 'The user took over the browser.',
    })
  })

  it('turns a thrown command error into a tool error', async () => {
    invoke.mockRejectedValueOnce(new Error('ipc down'))
    expect(await runBrowserAgentTool('browser_snapshot', {}, 't')).toEqual({
      error: 'ipc down',
    })
  })
})

describe('first visit', () => {
  it('asks, grants what was chosen, and retries', async () => {
    invoke.mockResolvedValueOnce(ask).mockResolvedValue(ok)
    const pending = runBrowserAgentTool(
      'browser_open',
      { url: 'https://example.com/a?b=1' },
      't'
    )
    const head = await answerNext('allow', 'session')
    // The dialog is given the whole address, query string included.
    expect(head.url).toBe('https://example.com/a?b=1')
    expect(head.host).toBe('example.com')
    expect(await pending).toEqual({ content: ok.content })
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      'browser_agent_call',
      'browser_agent_grant',
      'browser_agent_call',
    ])
    expect(invoke.mock.calls[1][1]).toEqual({
      pattern: 'example.com',
      scope: 'session',
    })
  })

  it('declining grants nothing and tells the model not to retry', async () => {
    invoke.mockResolvedValueOnce(ask)
    const pending = runBrowserAgentTool(
      'browser_open',
      { url: 'https://example.com' },
      't'
    )
    await answerNext('deny')
    expect(await pending).toEqual({
      error: expect.stringContaining('did not allow example.com'),
    })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('"never" saves a block rule', async () => {
    invoke.mockResolvedValueOnce(ask).mockResolvedValue({})
    const pending = runBrowserAgentTool(
      'browser_open',
      { url: 'https://example.com' },
      't'
    )
    await answerNext('never')
    expect('error' in (await pending)).toBe(true)
    expect(invoke).toHaveBeenLastCalledWith('browser_agent_block', {
      pattern: 'example.com',
    })
  })

  it('"also subdomains" grants the host, the base and the wildcard', async () => {
    invoke
      .mockResolvedValueOnce({ ...ask, host: 'www.example.com' })
      .mockResolvedValue(ok)
    const pending = runBrowserAgentTool(
      'browser_open',
      { url: 'https://www.example.com' },
      't'
    )
    await answerNext('allow', 'always', true)
    await pending
    const grants = invoke.mock.calls
      .filter((c) => c[0] === 'browser_agent_grant')
      .map((c) => c[1].pattern)
    expect(grants).toEqual(['www.example.com', 'example.com', '*.example.com'])
  })

  it('never asks a run with nobody to answer', async () => {
    invoke.mockResolvedValueOnce(ask)
    const r = await runBrowserAgentTool(
      'browser_open',
      { url: 'https://example.com' },
      't',
      { unattended: true }
    )
    expect(r).toEqual({ error: expect.stringContaining('did not allow') })
    expect(useBrowserAgentPrompt.getState().queue).toEqual([])
    expect(invoke.mock.calls[0][1].request.unattended).toBe(true)
  })

  it('a stopped run withdraws its question as a no', async () => {
    invoke.mockResolvedValueOnce(ask)
    const abort = new AbortController()
    const pending = runBrowserAgentTool(
      'browser_open',
      { url: 'https://example.com' },
      't',
      { signal: abort.signal }
    )
    await vi.waitFor(() =>
      expect(useBrowserAgentPrompt.getState().queue.length).toBe(1)
    )
    abort.abort()
    expect(await pending).toEqual({ error: expect.any(String) })
    expect(useBrowserAgentPrompt.getState().queue).toEqual([])
    expect(invoke.mock.calls.some((c) => c[0] === 'browser_agent_grant')).toBe(
      false
    )
  })

  it('gives up after a few questions instead of looping', async () => {
    invoke.mockResolvedValue(ask)
    const pending = runBrowserAgentTool(
      'browser_open',
      { url: 'https://example.com' },
      't'
    )
    for (let i = 0; i < 3; i++) {
      await answerNext('allow')
    }
    expect('error' in (await pending)).toBe(true)
  })
})

describe('actions', () => {
  it('ask for the normal tool approval before anything is sent', async () => {
    approve.mockResolvedValueOnce(false)
    const r = await runBrowserAgentTool('browser_click', { id: '1.2' }, 't', {
      callId: 'c1',
    })
    expect(r).toEqual({ error: expect.stringContaining('declined') })
    expect(approve).toHaveBeenCalledWith(
      'c1',
      'browser_click',
      't',
      undefined,
      expect.objectContaining({ input: { id: '1.2' }, alwaysAsk: false })
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it('send the click once approved', async () => {
    invoke.mockResolvedValueOnce(ok)
    const r = await runBrowserAgentTool('browser_click', { id: '1.2' }, 't', {
      callId: 'c1',
    })
    expect(r).toEqual({ content: ok.content })
    expect(invoke.mock.calls[0][1].request).toMatchObject({
      tool: 'click',
      id: '1.2',
      confirmed: false,
    })
  })

  it('a submit-like control asks again, every time, and retries confirmed', async () => {
    invoke
      .mockResolvedValueOnce({
        status: 'needs_confirmation',
        label: 'Buy now',
        reason: 'its label reads "Buy now"',
        url: 'https://shop.test/cart?x=1',
      })
      .mockResolvedValueOnce(ok)
    const r = await runBrowserAgentTool('browser_click', { id: '1.9' }, 't', {
      callId: 'c2',
    })
    expect(r).toEqual({ content: ok.content })
    expect(approve).toHaveBeenCalledTimes(2)
    const second = approve.mock.calls[1]
    expect(second[4]).toMatchObject({ alwaysAsk: true })
    expect(second[4].taskContext).toContain('Buy now')
    expect(second[4].taskContext).toContain('https://shop.test/cart?x=1')
    expect(invoke.mock.calls[1][1].request.confirmed).toBe(true)
  })

  it('a declined confirmation sends nothing more', async () => {
    invoke.mockResolvedValueOnce({
      status: 'needs_confirmation',
      label: 'Pay',
      reason: 'submits',
      url: 'https://shop.test/',
    })
    approve.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const r = await runBrowserAgentTool('browser_click', { id: '1.9' }, 't', {
      callId: 'c3',
    })
    expect(r).toEqual({ error: expect.stringContaining('declined') })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('unattended: no prompts, and a submit-like control is refused', async () => {
    invoke.mockResolvedValueOnce({
      status: 'needs_confirmation',
      label: 'Send',
      reason: 'submits',
      url: 'https://x.test/',
    })
    const r = await runBrowserAgentTool('browser_click', { id: '1.1' }, 't', {
      unattended: true,
    })
    expect(r).toEqual({ error: expect.stringContaining('nobody') })
    expect(approve).not.toHaveBeenCalled()
  })

  it('sends text, key and value arguments', async () => {
    invoke.mockResolvedValue(ok)
    await runBrowserAgentTool(
      'browser_type',
      { id: '2.3', text: 'hi', clear: false },
      't'
    )
    await runBrowserAgentTool('browser_press', { key: 'Escape' }, 't')
    await runBrowserAgentTool('browser_select', { id: '2.4', value: 'Blue' }, 't')
    const reqs = invoke.mock.calls.map((c) => c[1].request)
    expect(reqs[0]).toMatchObject({
      tool: 'type',
      id: '2.3',
      text: 'hi',
      clear: false,
    })
    expect(reqs[1]).toMatchObject({ tool: 'press', key: 'Escape' })
    expect(reqs[2]).toMatchObject({ tool: 'select', id: '2.4', value: 'Blue' })
  })

  it('the action cap from Settings is passed to the backend', async () => {
    useAgentToolsConfig.setState({ browserAgentMaxActions: 7 })
    invoke.mockResolvedValue(ok)
    await runBrowserAgentTool('browser_click', { id: '1.1' }, 't')
    expect(invoke.mock.calls[0][1].request.max_actions).toBe(7)
  })
})

describe('schemas and helpers', () => {
  it('advertise the seven tools, each saying page content is untrusted', () => {
    const schemas = browserAgentSchemas()
    expect(schemas.map((s) => s.function.name).sort()).toEqual(
      [...BROWSER_TOOL_NAMES].sort()
    )
    for (const s of schemas) {
      expect(s.function.description).toContain('untrusted')
      expect(s.function.description).toContain('never instructions')
      expect(s.function.parameters.type).toBe('object')
    }
    const open = schemas.find((s) => s.function.name === 'browser_open')!
    expect(open.function.parameters.required).toEqual(['url'])
  })

  it('knows which tools act', () => {
    for (const n of [
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_select',
    ]) {
      expect(isBrowserActionTool(n)).toBe(true)
    }
    for (const n of [
      'browser_open',
      'browser_read_text',
      'browser_snapshot',
      'bash',
    ]) {
      expect(isBrowserActionTool(n)).toBe(false)
    }
  })

  it('builds grant patterns', () => {
    expect(patternsFor('example.com', false)).toEqual(['example.com'])
    expect(patternsFor('example.com', true)).toEqual([
      'example.com',
      '*.example.com',
    ])
    expect(patternsFor('www.example.com', true)).toEqual([
      'www.example.com',
      'example.com',
      '*.example.com',
    ])
    expect(patternsFor('93.184.216.34', true)).toEqual(['93.184.216.34'])
    expect(patternsFor('::1', true)).toEqual(['::1'])
  })

  it('reads the page address out of a fenced result', () => {
    expect(urlFromBrowserOutput(ok.content)).toBe('https://example.com/')
    expect(urlFromBrowserOutput(JSON.stringify({ text: ok.content }))).toBe(
      'https://example.com/'
    )
    expect(urlFromBrowserOutput('plain')).toBe('')
    expect(
      browserCardUrl('browser_open', { url: 'https://a.test/' }, undefined)
    ).toBe('https://a.test/')
    expect(browserCardUrl('browser_click', { id: '1.1' }, undefined)).toBe('')
  })
})
