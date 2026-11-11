import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@/lib/platform/utils', () => ({ isServedByFlint: () => true }))
const renderPng = vi.fn()
vi.mock('@/lib/exportRender', () => ({
  printDocument: async () => 'unavailable',
  renderPng: (...a: unknown[]) => renderPng(...a),
  renderHtmlPage: () => '<html>page</html>',
  currentPdfStrategy: () => 'html',
}))

import { exportDocument } from '../exportFile'
import { exportFileName, type ExportDoc } from '../exportMarkdown'

const doc: ExportDoc = {
  title: 'Plan\u202Etxt.exe',
  scope: 'thread',
  exportedAt: '2026-10-01T10:00:00.000Z',
  messages: [{ role: 'user', text: 'hello' }],
}

let clicked: { name: string; href: string }[]
let blobs: Blob[]

beforeEach(() => {
  invoke.mockReset()
  renderPng.mockReset()
  clicked = []
  blobs = []
  URL.createObjectURL = (b: Blob | MediaSource) => {
    blobs.push(b as Blob)
    return `blob:${blobs.length}`
  }
  URL.revokeObjectURL = () => undefined
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push({ name: this.download, href: this.href })
  })
})

afterEach(() => vi.restoreAllMocks())

describe('exportDocument in the browser build', () => {
  it.each([
    ['markdown', 'md', 'text/markdown'],
    ['obsidian', 'md', 'text/markdown'],
    ['pdf', 'html', 'text/html'],
  ] as const)('downloads %s as a .%s file without calling the server', async (format, ext, mime) => {
    const out = await exportDocument(doc, format)
    expect(out).toMatchObject({ ok: true, path: `Plantxt.exe.${ext}` })
    expect(invoke).not.toHaveBeenCalled()
    expect(clicked).toEqual([{ name: `Plantxt.exe.${ext}`, href: 'blob:1' }])
    expect(blobs[0].type).toContain(mime)
    expect(document.querySelector('a[download]')).toBeNull()
  })

  it('downloads a PNG from the rendered image bytes', async () => {
    renderPng.mockResolvedValue({ ok: true, base64: btoa('\x89PNG') })
    const out = await exportDocument(doc, 'image')
    expect(out).toMatchObject({ ok: true, path: 'Plantxt.exe.png' })
    expect(blobs[0].type).toBe('image/png')
    expect(blobs[0].size).toBe(4)
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('exportFileName', () => {
  it('drops bidi and zero-width characters and keeps RTL text', () => {
    expect(exportFileName('a\u202Eb\u2066c\u200Bd', 'md')).toBe('abcd.md')
    expect(exportFileName('שלום עולם', 'md')).toBe('שלום עולם.md')
  })

  it('defuses reserved names and trailing dots or spaces', () => {
    expect(exportFileName('CON', 'md')).toBe('_CON.md')
    expect(exportFileName('notes. . ', 'md')).toBe('notes.md')
    expect(exportFileName('a\u0007b', 'md')).toBe('a b.md')
  })
})
