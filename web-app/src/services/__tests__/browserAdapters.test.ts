// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserThreadsService } from '../threads/browser'
import { BrowserMessagesService } from '../messages/browser'
import { BrowserProjectsService } from '../projects/browser'
import { BrowserAssistantsService } from '../assistants/browser'
import { BrowserMCPService } from '../mcp/browser'
import { BrowserRAGService } from '../rag/browser'
import { BrowserUploadsService, uploadFile } from '../uploads/browser'
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

  it('changes one project per request so browsers cannot overwrite each other', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 201, redirected: false, json: async () => ({ id: 'n', name: 'New' }) })
      .mockResolvedValueOnce({ ok: true, status: 204, redirected: false })
      .mockResolvedValueOnce({ ok: true, status: 204, redirected: false })
    vi.stubGlobal('fetch', fetch)
    const projects = new BrowserProjectsService()
    await projects.addProject('New', 'assistant')
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/projects')
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ name: 'New', assistantId: 'assistant' })
    await projects.updateProject('a b', 'Renamed')
    expect(fetch.mock.calls[1][0]).toBe('/api/v1/projects/a%20b')
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'PUT' })
    await projects.deleteProject('a')
    expect(fetch.mock.calls[2][0]).toBe('/api/v1/projects/a')
    expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'DELETE' })
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

  it('uploads a picked file and parses it on the server', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 201, redirected: false, json: async () => ({ id: 'a'.repeat(32), name: 'n.txt', size: 2, path: '/srv/uploads/x/n.txt' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, redirected: false, json: async () => ({ text: 'hello' }) })
    vi.stubGlobal('fetch', fetch)
    const stored = await uploadFile(new File(['hi'], 'my notes.txt'))
    expect(stored.path).toBe('/srv/uploads/x/n.txt')
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/uploads?name=my%20notes.txt')
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(await new BrowserRAGService().parseDocument(stored.path, 'txt')).toBe('hello')
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ path: '/srv/uploads/x/n.txt', type: 'txt' })
  })

  it('says why embedding ingestion is unavailable', async () => {
    const uploads = new BrowserUploadsService()
    await expect(uploads.ingestFileAttachment('t', { type: 'document', name: 'a' } as never)).rejects.toThrow(/inline/)
    await expect(uploads.ingestFileAttachmentForProject('p', { type: 'document', name: 'a' } as never)).rejects.toThrow(/inline/)
  })
})
