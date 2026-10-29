import { describe, expect, it } from 'vitest'
import {
  dragHasFiles,
  fileUriPaths,
  pasteFilePaths,
  transferFilePaths,
  type TransferLike,
} from '@/lib/fileDrop'

/**
 * Payload shapes as Linux file managers put them on a drag or the clipboard,
 * and as WebKitGTK hands them to the page. No Linux desktop was available to
 * capture these live; they follow each tool's documented format.
 */
const transfer = (data: Record<string, string>): TransferLike => ({
  types: Object.keys(data),
  getData: (type: string) => data[type] ?? '',
})

const dt = (types: string[]) =>
  ({ types, files: { length: 0 } }) as unknown as DataTransfer

describe('fileUriPaths edge cases', () => {
  it('accepts file:/path with a single slash', () => {
    expect(fileUriPaths('file:/home/me/a.png')).toEqual(['/home/me/a.png'])
  })
  it('drops a trailing NUL and CRLF line ends', () => {
    expect(fileUriPaths('file:///home/me/a.png\r\n\u0000')).toEqual(['/home/me/a.png'])
    expect(fileUriPaths('file:///home/me/a.png\u0000')).toEqual(['/home/me/a.png'])
  })
  it('decodes unicode and keeps + literal', () => {
    expect(fileUriPaths('file:///home/me/%C3%A9t%C3%A9%20a+b.txt')).toEqual([
      '/home/me/été a+b.txt',
    ])
  })
  it('keeps a malformed escape as written instead of giving up', () => {
    expect(fileUriPaths('file:///home/me/100%.txt')).toEqual(['/home/me/100%.txt'])
  })
  it('strips a directory trailing slash', () => {
    expect(fileUriPaths('file:///home/me/Projects/')).toEqual(['/home/me/Projects'])
  })
  it('accepts unencoded spaces some tools emit', () => {
    expect(fileUriPaths('file:///home/me/my file.txt')).toEqual(['/home/me/my file.txt'])
  })
})

describe('transferFilePaths', () => {
  it('reads a Nautilus/GTK drag: text/uri-list with CRLF', () => {
    const d = transfer({
      'text/uri-list': 'file:///home/me/a%20b.png\r\nfile:///home/me/c.pdf\r\n',
    })
    expect(transferFilePaths(d)).toEqual(['/home/me/a b.png', '/home/me/c.pdf'])
  })

  it('reads x-special/gnome-copied-files (copy and cut)', () => {
    expect(
      transferFilePaths(
        transfer({
          'x-special/gnome-copied-files': 'copy\nfile:///home/me/a.txt\nfile:///home/me/b.txt',
        })
      )
    ).toEqual(['/home/me/a.txt', '/home/me/b.txt'])
    expect(
      transferFilePaths(
        transfer({ 'x-special/gnome-copied-files': 'cut\nfile:///home/me/a.txt\u0000' })
      )
    ).toEqual(['/home/me/a.txt'])
  })

  it('reads the Nautilus 3.x text/plain clipboard header', () => {
    const d = transfer({
      'text/plain':
        'x-special/nautilus-clipboard\ncopy\nfile:///home/me/Pictures/evil%20corp.png\n',
    })
    expect(transferFilePaths(d)).toEqual(['/home/me/Pictures/evil corp.png'])
  })

  it('reads text/plain file URIs (Dolphin, Thunar, PCManFM)', () => {
    expect(transferFilePaths(transfer({ 'text/plain': 'file:///home/me/a.txt' }))).toEqual([
      '/home/me/a.txt',
    ])
  })

  it('reads text/x-moz-url url/title pairs', () => {
    const d = transfer({
      'text/x-moz-url': 'file:///home/me/a.txt\na.txt\nfile:///home/me/b.txt\nb.txt',
    })
    expect(transferFilePaths(d)).toEqual(['/home/me/a.txt', '/home/me/b.txt'])
  })

  it('reads file://localhost URIs', () => {
    expect(
      transferFilePaths(transfer({ 'text/uri-list': 'file://localhost/home/me/a.txt' }))
    ).toEqual(['/home/me/a.txt'])
  })

  it('falls through an empty uri-list to text/plain', () => {
    expect(
      transferFilePaths(
        transfer({ 'text/uri-list': '', 'text/plain': 'file:///home/me/a.txt' })
      )
    ).toEqual(['/home/me/a.txt'])
  })

  it('takes bare absolute paths in text/plain only when allowed (drops)', () => {
    const d = transfer({ 'text/plain': '/home/me/a.txt\n"/home/me/my file.png"' })
    expect(transferFilePaths(d)).toBeNull()
    expect(transferFilePaths(d, { allowBarePaths: true })).toEqual([
      '/home/me/a.txt',
      '/home/me/my file.png',
    ])
  })

  it('dedupes the same file offered in several types', () => {
    const d = transfer({
      'text/uri-list': 'file:///home/me/a.txt',
      'x-special/gnome-copied-files': 'copy\nfile:///home/me/a.txt',
      'text/plain': 'file:///home/me/a.txt',
    })
    expect(transferFilePaths(d)).toEqual(['/home/me/a.txt'])
  })

  it('leaves ordinary text, web links and remote file hosts alone', () => {
    expect(transferFilePaths(transfer({ 'text/plain': 'hello world' }))).toBeNull()
    expect(
      transferFilePaths(transfer({ 'text/uri-list': 'https://example.com/a.png' }))
    ).toBeNull()
    expect(
      transferFilePaths(transfer({ 'text/uri-list': 'file://server/share/a.png' }))
    ).toBeNull()
    expect(
      transferFilePaths(transfer({ 'text/plain': '/clear' }), { allowBarePaths: true })
    ).toBeNull()
    expect(transferFilePaths(null)).toBeNull()
  })

  it('survives a getData that throws (protected drag data)', () => {
    const d: TransferLike = {
      types: ['text/uri-list'],
      getData: () => {
        throw new Error('denied')
      },
    }
    expect(transferFilePaths(d)).toBeNull()
  })
})

const dtData = (data: Record<string, string>) =>
  ({
    types: Object.keys(data),
    files: { length: 0 },
    getData: (t: string) => data[t] ?? '',
  }) as unknown as DataTransfer

describe('dragHasFiles on WebKitGTK', () => {
  it('counts a file-manager drag whose uri-list is file: URIs', () => {
    expect(
      dragHasFiles(dtData({ 'text/uri-list': 'file:///home/me/a.txt', 'text/plain': '' }))
    ).toBe(true)
    expect(dragHasFiles(dt(['x-special/gnome-copied-files']))).toBe(true)
  })
  it('does not count a web link dragged from a browser (has text/html)', () => {
    expect(dragHasFiles(dt(['text/uri-list', 'text/html', 'text/plain']))).toBe(false)
  })
  it('does not count a Chrome address-bar drag (uri-list + text/plain, no html)', () => {
    expect(
      dragHasFiles(
        dtData({
          'text/uri-list': 'https://example.com/page',
          'text/plain': 'https://example.com/page',
        })
      )
    ).toBe(false)
  })
  it('falls back to Files-only when the uri-list is unreadable during dragover', () => {
    expect(dragHasFiles(dtData({ 'text/uri-list': '' }))).toBe(false)
  })
})

describe('unsafe paths are never returned', () => {
  it('rejects UNC via four slashes or a host-looking path', () => {
    expect(fileUriPaths('file:////server/share/x')).toBeNull()
    expect(fileUriPaths('file:///%2F%2Fserver/share/x')).toBeNull()
    expect(fileUriPaths('file:///%5C%5Cserver/share/x')).toBeNull()
  })
  it('rejects traversal segments', () => {
    expect(fileUriPaths('file:///home/me/..%2F..%2Fetc/passwd')).toBeNull()
    expect(fileUriPaths('file:///home/me/../etc/passwd')).toBeNull()
  })
  it('rejects UNC bare paths in a drop', () => {
    expect(
      transferFilePaths(transfer({ 'text/plain': '\\\\server\\share\\x.txt' }), {
        allowBarePaths: true,
      })
    ).toBeNull()
    expect(
      transferFilePaths(transfer({ 'text/plain': '//server/share/x.txt' }), {
        allowBarePaths: true,
      })
    ).toBeNull()
  })
  it('keeps a drive root as C:/', () => {
    expect(fileUriPaths('file:///C:/')).toEqual(['C:/'])
  })
})

describe('pasteFilePaths trust', () => {
  it('trusts only x-special/gnome-copied-files', () => {
    expect(
      pasteFilePaths(
        transfer({
          'x-special/gnome-copied-files': 'copy\nfile:///home/me/a.txt',
          'text/uri-list': 'file:///home/me/a.txt',
        })
      )
    ).toEqual({ paths: ['/home/me/a.txt'], trusted: true })
  })
  it('marks uri-list / text/plain URIs (forgeable by a page) untrusted', () => {
    expect(
      pasteFilePaths(transfer({ 'text/uri-list': 'file:///home/me/.bashrc' }))
    ).toEqual({ paths: ['/home/me/.bashrc'], trusted: false })
    expect(
      pasteFilePaths(
        transfer({ 'text/plain': 'x-special/nautilus-clipboard\ncopy\nfile:///home/me/a.txt' })
      )
    ).toEqual({ paths: ['/home/me/a.txt'], trusted: false })
  })
  it('returns null when real File objects are present (use those)', () => {
    const d = {
      ...transfer({ 'text/uri-list': 'file:///Users/me/a.txt' }),
      files: { length: 1 },
    }
    expect(pasteFilePaths(d)).toBeNull()
  })
  it('returns null for ordinary text', () => {
    expect(pasteFilePaths(transfer({ 'text/plain': 'hi' }))).toBeNull()
  })
})

describe('dropFilePaths trust', () => {
  const t = (data: Record<string, string>) => ({
    types: Object.keys(data),
    getData: (k: string) => data[k] ?? '',
    files: [],
  })

  it('trusts only the GNOME copied-files type', async () => {
    const { dropFilePaths } = await import('../fileDrop')
    expect(
      dropFilePaths(t({ 'x-special/gnome-copied-files': 'copy\nfile:///home/me/a.txt' }))
    ).toEqual({ paths: ['/home/me/a.txt'], trusted: true })
  })

  it('does not trust the GNOME type on a drag that started in-app', async () => {
    const { dropFilePaths, setInAppDragForTest } = await import('../fileDrop')
    setInAppDragForTest(true)
    try {
      expect(
        dropFilePaths(t({ 'x-special/gnome-copied-files': 'copy\nfile:///home/me/a.txt' }))
      ).toEqual({ paths: ['/home/me/a.txt'], trusted: false })
    } finally {
      setInAppDragForTest(false)
    }
  })

  it('names but does not trust text a page could have set', async () => {
    const { dropFilePaths } = await import('../fileDrop')
    expect(dropFilePaths(t({ 'text/plain': '/home/me/.ssh/id_rsa' }))).toEqual({
      paths: ['/home/me/.ssh/id_rsa'],
      trusted: false,
    })
    expect(dropFilePaths(t({ 'text/uri-list': 'file:///home/me/.bashrc' }))?.trusted).toBe(false)
  })

  it('leaves real File objects to their own handler', async () => {
    const { dropFilePaths } = await import('../fileDrop')
    expect(
      dropFilePaths({ ...t({ 'text/uri-list': 'file:///a' }), files: [{}] as never })
    ).toBeNull()
  })
})
