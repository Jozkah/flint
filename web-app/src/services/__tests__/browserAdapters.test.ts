// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserThreadsService } from '../threads/browser'
import { BrowserMessagesService } from '../messages/browser'
import { BrowserProjectsService } from '../projects/browser'
import { BrowserAssistantsService } from '../assistants/browser'
import { BrowserMCPService } from '../mcp/browser'
import type { ThreadMessage } from '@janhq/core'

afterEach(() => vi.unstubAllGlobals())

describe('headless browser adapters', () => {
  it('reads durable threads and uses authenticated same-origin requests', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      redirected: false,
      json: async () => [{ id: 'one', title: 'One', updated: 2_000_000_000_000 }],
    })
    vi.stubGlobal('fetch', fetch)
    const threads = await new BrowserThreadsService().fetchThreads()
    expect(threads).toMatchObject([{ id: 'one', updated: 2_000_000_000 }])
    expect(fetch).toHaveBeenCalledWith('/api/v1/threads', { credentials: 'same-origin' })
  })

  it('sends message mutations to matching thread route', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      redirected: false,
      json: async () => ({ id: 'message', thread_id: 'thread 1' }),
    })
    vi.stubGlobal('fetch', fetch)
    await new BrowserMessagesService().createMessage({ thread_id: 'thread 1' } as ThreadMessage)
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/threads/thread%201/messages',
      expect.objectContaining({
        credentials: 'same-origin',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    )
  })

  it('stores projects as one list on the server', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, redirected: false, json: async () => [{ id: 'a', name: 'A', updated_at: 1 }] })
      .mockResolvedValueOnce({ ok: true, status: 204, redirected: false })
    vi.stubGlobal('fetch', fetch)
    await new BrowserProjectsService().deleteProject('a')
    const [url, init] = fetch.mock.calls[1]
    expect(url).toBe('/api/v1/projects')
    expect(init).toMatchObject({ method: 'PUT', body: '[]' })
  })

  it('addresses assistants by encoded id', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204, redirected: false })
    vi.stubGlobal('fetch', fetch)
    await new BrowserAssistantsService().deleteAssistant({ id: 'a b' } as never)
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/assistants/a%20b',
      expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' })
    )
  })

  it('carries MCP calls and approvals to the server', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, redirected: false, json: async () => ({ error: '', content: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, redirected: false, json: async () => ({ ticket: 't1' }) })
      .mockResolvedValueOnce({ ok: true, status: 204, redirected: false })
    vi.stubGlobal('fetch', fetch)
    const mcp = new BrowserMCPService()
    await mcp.callTool({ toolName: 'search', serverName: 'web', arguments: { q: 'x' }, approvalTicket: 'tk' })
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ toolName: 'search', approvalTicket: 'tk' })
    expect(await mcp.allowOnceForServer('web', 'search', 'fp')).toBe('t1')
    await mcp.activateMCPServer('my server', { command: 'x' } as never, { start: false })
    expect(fetch.mock.calls[2][0]).toBe('/api/v1/mcp/servers/my%20server/activate')
    expect(JSON.parse(fetch.mock.calls[2][1].body).start).toBe(false)
  })
})
