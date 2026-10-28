import { describe, it, expect, vi } from 'vitest'
import {
  addWebPageToProject,
  classifyFetchError,
  fileNameForPage,
  refreshWebPageSource,
  UrlSourceError,
  validateWebPageUrl,
  type UrlSourceDeps,
} from '../projectUrlSources'

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0)

function deps(over: Partial<UrlSourceDeps> = {}): UrlSourceDeps & {
  saved: Map<string, string>
} {
  const saved = new Map<string, string>()
  let n = 0
  return {
    saved,
    fetchPage: vi.fn(async (url: string) => ({
      url,
      title: 'Release notes: v2',
      content: 'Hello from the page.',
      truncated: false,
    })),
    saveFile: vi.fn(async (name: string, text: string) => {
      const path = `/data/attachments/${++n}/${name}`
      saved.set(path, text)
      return path
    }),
    ingest: vi.fn(async () => ({ id: `file-${n}`, chunkCount: 1 })),
    deleteFile: vi.fn(async () => {}),
    now: () => NOW,
    ...over,
  }
}

describe('validateWebPageUrl', () => {
  it.each(['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'example.com', ''])(
    'refuses %s',
    (u) => {
      expect(() => validateWebPageUrl(u)).toThrow(UrlSourceError)
    }
  )
  it('accepts http and https', () => {
    expect(validateWebPageUrl(' https://example.com/a ').hostname).toBe('example.com')
    expect(validateWebPageUrl('http://example.com').protocol).toBe('http:')
  })
  it('refuses a file download as not a page', () => {
    expect(() => validateWebPageUrl('https://example.com/report.pdf')).toThrow(
      expect.objectContaining({ code: 'notHtml' })
    )
  })
})

describe('addWebPageToProject', () => {
  it('saves the page as markdown and ingests it with its source', async () => {
    const d = deps()
    const added = await addWebPageToProject('p1', 'https://example.com/notes', d)

    expect(d.fetchPage).toHaveBeenCalledWith('https://example.com/notes')
    expect(added.name).toBe('Release notes v2.md')
    expect(added.source).toEqual({
      url: 'https://example.com/notes',
      fetchedAt: NOW,
      path: '/data/attachments/1/Release notes v2.md',
    })
    const text = d.saved.get(added.source.path)!
    expect(text).toContain('Source: https://example.com/notes')
    expect(text).toContain('Fetched: 2026-10-28T12:00:00.000Z')
    expect(text).toContain('Hello from the page.')
    expect(d.ingest).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ type: 'document', fileType: 'md', path: added.source.path })
    )
    expect(added.fileId).toBe('file-1')
  })

  it('refuses a private address through the web_fetch guard and saves nothing', async () => {
    const d = deps({
      fetchPage: vi.fn(async () => {
        throw {
          message:
            'refused to fetch http://192.168.1.1/: 192.168.1.1 is a local or private address',
        }
      }),
    })
    await expect(addWebPageToProject('p1', 'http://192.168.1.1/', d)).rejects.toMatchObject({
      code: 'blocked',
    })
    expect(d.saveFile).not.toHaveBeenCalled()
    expect(d.ingest).not.toHaveBeenCalled()
  })

  it('treats a page with no readable text as not a web page', async () => {
    const d = deps({
      fetchPage: vi.fn(async (url: string) => ({ url, title: '', content: '  ', truncated: false })),
    })
    await expect(addWebPageToProject('p1', 'https://example.com', d)).rejects.toMatchObject({
      code: 'notHtml',
    })
  })
})

describe('refreshWebPageSource', () => {
  it('ingests the new copy, then deletes the old file and its chunks', async () => {
    const d = deps()
    const first = await addWebPageToProject('p1', 'https://example.com/notes', d)
    const order: string[] = []
    ;(d.ingest as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('ingest')
      return { id: 'file-2' }
    })
    ;(d.deleteFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('delete')
    })

    const next = await refreshWebPageSource('p1', first.fileId, first.source, d)

    expect(d.deleteFile).toHaveBeenCalledWith('p1', 'file-1')
    expect(order).toEqual(['ingest', 'delete'])
    expect(next.fileId).toBe('file-2')
    expect(next.source.url).toBe(first.source.url)
  })

  it('keeps the old file when the re-fetch fails', async () => {
    const d = deps({
      fetchPage: vi.fn(async () => {
        throw { message: 'SearXNG fetch request failed: operation timed out' }
      }),
    })
    await expect(
      refreshWebPageSource('p1', 'file-1', { url: 'https://example.com', fetchedAt: 1, path: '/x.md' }, d)
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(d.deleteFile).not.toHaveBeenCalled()
  })
})

describe('classifyFetchError / fileNameForPage', () => {
  it('maps the backend messages', () => {
    expect(classifyFetchError({ message: 'x fetch failed with HTTP 404' }).code).toBe('httpError')
    expect(classifyFetchError(new Error('something else')).code).toBe('failed')
  })
  it('falls back to the host for an untitled page', () => {
    expect(fileNameForPage('  ', new URL('https://docs.example.org/x'))).toBe('docs.example.org.md')
  })
})
