import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}))

import {
  BROWSER_TOOL_NAMES,
  browserAgentSchemas,
  browserCallOptions,
  browserCardUrl,
  isBrowserActionTool,
  patternsFor,
  reduceMotionFlag,
  runBrowserAgentTool,
  urlFromBrowserOutput,
} from '@/lib/browserAgent'
import { describeNativeToolCall } from '@/lib/toolPresentation'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { useBrowserAgentPrompt } from '@/hooks/useBrowserAgentPrompt'
import { useBrowserShots } from '@/hooks/useBrowserShots'
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
    browserAgentPointer: true,
    browserAgentReduceMotion: 'system',
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

describe('screenshot', () => {
  it('is a read tool: no action approval, and the picture goes to the card, not the model', async () => {
    invoke.mockResolvedValueOnce({
      ...ok,
      content: '<untrusted_web_content id=a kind=screenshot url="https://example.com/">saved</untrusted_web_content id=a>',
      image: 'QUJD',
    })
    const r = await runBrowserAgentTool('browser_screenshot', {}, 't', { callId: 'shot-1' })
    expect(r).toEqual({ content: expect.stringContaining('saved') })
    expect(JSON.stringify(r)).not.toContain('QUJD')
    expect(useBrowserShots.getState().shots['shot-1']).toBe('QUJD')
    expect(approve).not.toHaveBeenCalled()
    expect(invoke.mock.calls[0][1].request.tool).toBe('screenshot')
  })

  it('reports an unsupported platform as the tool error', async () => {
    invoke.mockResolvedValueOnce({ status: 'error', reason: 'browser_screenshot is not supported on this platform yet' })
    expect(await runBrowserAgentTool('browser_screenshot', {}, 't', { callId: 'shot-2' })).toEqual({
      error: expect.stringContaining('not supported on this platform'),
    })
    expect(useBrowserShots.getState().shots['shot-2']).toBeUndefined()
  })

  it('says in its description that the image is untrusted', () => {
    const d = browserAgentSchemas().find((s) => s.function.name === 'browser_screenshot')!.function.description
    expect(d).toContain('untrusted page content')
  })
})

describe('scroll and the pointer', () => {
  it('is a read-like action: no approval, direction and amount passed through', async () => {
    invoke.mockResolvedValueOnce(ok)
    const r = await runBrowserAgentTool(
      'browser_scroll',
      { direction: 'down', amount: 300 },
      't',
      { callId: 's1' }
    )
    expect(r).toEqual({ content: ok.content })
    expect(approve).not.toHaveBeenCalled()
    expect(invoke.mock.calls[0][1].request).toMatchObject({
      tool: 'scroll',
      direction: 'down',
      amount: '300',
    })
    expect(isBrowserActionTool('browser_scroll')).toBe(false)
  })

  it('a node id alone is sent as an id', async () => {
    invoke.mockResolvedValueOnce(ok)
    await runBrowserAgentTool('browser_scroll', { id: '2.4' }, 't')
    expect(invoke.mock.calls[0][1].request).toMatchObject({ tool: 'scroll', id: '2.4' })
  })

  it('still needs the domain permission like a read', async () => {
    invoke.mockResolvedValueOnce(ask).mockResolvedValue(ok)
    const pending = runBrowserAgentTool('browser_scroll', { direction: 'down' }, 't')
    await answerNext('allow')
    expect(await pending).toEqual({ content: ok.content })
  })

  it('passes the pointer settings with every call', async () => {
    invoke.mockResolvedValue(ok)
    await runBrowserAgentTool('browser_snapshot', {}, 't')
    expect(invoke.mock.calls[0][1].request).toMatchObject({ pointer: true, reduce_motion: null })
    useAgentToolsConfig.setState({ browserAgentPointer: false, browserAgentReduceMotion: 'on' })
    await runBrowserAgentTool('browser_scroll', { direction: 'down' }, 't')
    expect(invoke.mock.calls[1][1].request).toMatchObject({ pointer: false, reduce_motion: true })
    useAgentToolsConfig.setState({ browserAgentPointer: true, browserAgentReduceMotion: 'off' })
    await runBrowserAgentTool('browser_snapshot', {}, 't')
    expect(invoke.mock.calls[2][1].request).toMatchObject({ pointer: true, reduce_motion: false })
    expect(reduceMotionFlag('system')).toBeNull()
  })

  it('the approval prompt comes before the call that moves the pointer', async () => {
    const order: string[] = []
    approve.mockImplementation(async () => {
      order.push('approve')
      return true
    })
    invoke.mockImplementation(async (_cmd: string, a: { request: { validate_only?: boolean } }) => {
      order.push(a.request.validate_only ? 'validate' : 'act')
      return a.request.validate_only ? validated : ok
    })
    await runBrowserAgentTool('browser_click', { id: '1.1' }, 't', { callId: 'c' })
    // Nothing that moves the pointer runs before the user has said yes.
    expect(order).toEqual(['validate', 'approve', 'act'])
  })

  it('declares its schema with a direction enum, and says it counts as an action', () => {
    const s = browserAgentSchemas().find((x) => x.function.name === 'browser_scroll')!
    const p = s.function.parameters as { properties: { direction: { enum: string[] } }; required: string[] }
    expect(p.properties.direction.enum).toEqual(['up', 'down', 'left', 'right'])
    expect(p.required).toEqual([])
    expect(s.function.description).toContain('action limit')
    expect(s.function.description).toContain('untrusted')
  })

  it('has a tool-card bar naming the direction', () => {
    expect(
      describeNativeToolCall({ kind: 'agent' } as never, 'browser_scroll', { direction: 'down' })
    ).toEqual({ variant: 'workspace', tool: 'browser_scroll', target: 'down' })
  })
})

/** What the backend says about a node it checked: still there, and what it is. */
const validated = {
  status: 'ok',
  content: '',
  url: 'https://shop.test/cart?id=7',
  label: 'Add to cart',
}

/** Script the backend: validation answers itself, the rest come from `rest`. */
function backend(...rest: unknown[]) {
  const queue = [...rest]
  invoke.mockImplementation(async (_cmd: string, a: { request: { validate_only?: boolean } }) =>
    a.request.validate_only ? validated : queue.shift()
  )
}

const actCalls = () =>
  invoke.mock.calls.map((c) => c[1].request).filter((r) => !r.validate_only)

describe('actions', () => {
  it('check the node first: a stale id is refused before the user is asked', async () => {
    invoke.mockResolvedValueOnce({
      status: 'error',
      reason: 'Node 3.1 is from an older snapshot. Call browser_snapshot again.',
    })
    const r = await runBrowserAgentTool('browser_click', { id: '3.1' }, 't', { callId: 'c0' })
    expect(r).toEqual({ error: expect.stringContaining('older snapshot') })
    expect(approve).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0][1].request).toMatchObject({ tool: 'click', validate_only: true })
  })

  it('a first-visit site is asked about before the action approval', async () => {
    const order: string[] = []
    approve.mockImplementation(async () => {
      order.push('approve')
      return true
    })
    invoke
      .mockResolvedValueOnce(ask)
      .mockImplementation(async (c: string, a: { request?: { validate_only?: boolean } }) =>
        c !== 'browser_agent_call' ? undefined : a.request?.validate_only ? validated : ok
      )
    const pending = runBrowserAgentTool('browser_click', { id: '1.2' }, 't', { callId: 'c' })
    await vi.waitFor(() => expect(useBrowserAgentPrompt.getState().queue.length).toBe(1))
    order.push('site-question')
    await answerNext('allow')
    expect(await pending).toEqual({ content: ok.content })
    expect(order).toEqual(['site-question', 'approve'])
  })

  it('ask for the normal tool approval before anything is sent, naming the control and page', async () => {
    backend()
    approve.mockResolvedValueOnce(false)
    const r = await runBrowserAgentTool('browser_click', { id: '1.2' }, 't', { callId: 'c1' })
    expect(r).toEqual({ error: expect.stringContaining('declined') })
    expect(approve).toHaveBeenCalledWith(
      'c1',
      'browser_click',
      't',
      undefined,
      expect.objectContaining({
        input: { id: '1.2', control: 'Add to cart', page: 'https://shop.test/cart?id=7' },
        alwaysAsk: false,
        taskContext: expect.stringContaining('"Add to cart"'),
      })
    )
    expect(actCalls()).toHaveLength(0)
  })

  it('send the click once approved', async () => {
    backend(ok)
    const r = await runBrowserAgentTool('browser_click', { id: '1.2' }, 't', { callId: 'c1' })
    expect(r).toEqual({ content: ok.content })
    expect(actCalls()[0]).toMatchObject({ tool: 'click', id: '1.2', confirmed: false })
  })

  it('a submit-like control asks again, every time, and retries confirmed', async () => {
    backend(
      {
        status: 'needs_confirmation',
        label: 'Buy now',
        reason: 'its label reads "Buy now"',
        url: 'https://shop.test/cart?x=1',
      },
      ok
    )
    const r = await runBrowserAgentTool('browser_click', { id: '1.9' }, 't', { callId: 'c2' })
    expect(r).toEqual({ content: ok.content })
    expect(approve).toHaveBeenCalledTimes(2)
    const second = approve.mock.calls[1]
    expect(second[4]).toMatchObject({ alwaysAsk: true })
    expect(second[4].taskContext).toContain('Buy now')
    expect(second[4].taskContext).toContain('https://shop.test/cart?x=1')
    expect(actCalls()[1].confirmed).toBe(true)
  })

  it('a declined confirmation sends nothing more', async () => {
    backend({
      status: 'needs_confirmation',
      label: 'Pay',
      reason: 'submits',
      url: 'https://shop.test/',
    })
    approve.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const r = await runBrowserAgentTool('browser_click', { id: '1.9' }, 't', { callId: 'c3' })
    expect(r).toEqual({ error: expect.stringContaining('declined') })
    expect(actCalls()).toHaveLength(1)
  })

  it('unattended: no prompts, and a submit-like control is refused', async () => {
    backend({
      status: 'needs_confirmation',
      label: 'Send',
      reason: 'submits',
      url: 'https://x.test/',
    })
    const r = await runBrowserAgentTool('browser_click', { id: '1.1' }, 't', { unattended: true })
    expect(r).toEqual({ error: expect.stringContaining('nobody') })
    expect(approve).not.toHaveBeenCalled()
  })

  it('sends text, key and value arguments', async () => {
    backend(ok, ok, ok)
    await runBrowserAgentTool('browser_type', { id: '2.3', text: 'hi', clear: false }, 't')
    await runBrowserAgentTool('browser_press', { key: 'Escape' }, 't')
    await runBrowserAgentTool('browser_select', { id: '2.4', value: 'Blue' }, 't')
    const reqs = actCalls()
    expect(reqs[0]).toMatchObject({ tool: 'type', id: '2.3', text: 'hi', clear: false })
    expect(reqs[1]).toMatchObject({ tool: 'press', key: 'Escape' })
    expect(reqs[2]).toMatchObject({ tool: 'select', id: '2.4', value: 'Blue' })
  })

  it('the action cap from Settings is passed to the backend', async () => {
    useAgentToolsConfig.setState({ browserAgentMaxActions: 7 })
    backend(ok)
    await runBrowserAgentTool('browser_click', { id: '1.1' }, 't')
    expect(actCalls()[0].max_actions).toBe(7)
  })

  it('the chat card id is what the approval is keyed by (so it is answerable there)', () => {
    expect(browserCallOptions('browser_click', 'call-77')).toEqual({ callId: 'call-77' })
    expect(browserCallOptions('browser_scroll', 'call-78')).toEqual({ callId: 'call-78' })
    expect(browserCallOptions('bash', 'call-79')).toEqual({})
  })
})

describe('schemas and helpers', () => {
  it('advertise the nine tools, each saying page content is untrusted', () => {
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
