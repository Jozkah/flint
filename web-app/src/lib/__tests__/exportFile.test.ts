import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
const printDocument = vi.fn()
const renderPng = vi.fn()
vi.mock('@/lib/exportRender', () => ({
  printDocument: (...a: unknown[]) => printDocument(...a),
  renderPng: (...a: unknown[]) => renderPng(...a),
  renderHtmlPage: () => '<html>page</html>',
  currentPdfStrategy: () => 'print',
}))

import { exportDocument, redactDoc, sizeProblem, MAX_EXPORT_BYTES } from '../exportFile'
import type { ExportDoc } from '../exportMarkdown'

const doc: ExportDoc = {
  title: 'Notes: a/b',
  scope: 'thread',
  exportedAt: '2026-10-01T10:00:00.000Z',
  messages: [{ role: 'user', text: 'use Authorization: Bearer abcdef1234567890SECRET' }],
}

beforeEach(() => {
  invoke.mockReset()
  printDocument.mockReset()
  renderPng.mockReset()
})

describe('exportDocument', () => {
  it('sends Markdown text, a sanitized suggested name and no path', async () => {
    invoke.mockResolvedValue({ path: 'C:\\out\\Notes- a-b.md', redactions: 0 })
    const out = await exportDocument(doc, 'markdown')
    expect(out).toMatchObject({ ok: true, path: 'C:\\out\\Notes- a-b.md' })
    const [cmd, args] = invoke.mock.calls[0]
    expect(cmd).toBe('export_save_file')
    expect(args.ext).toBe('md')
    expect(args.suggestedName).toBe('Notes- a-b.md')
    expect(args).not.toHaveProperty('path')
    expect(args.text).toContain('# Notes: a/b')
  })

  it('redacts credentials before anything is sent and counts them', async () => {
    invoke.mockResolvedValue({ path: 'p.md', redactions: 1 })
    const out = await exportDocument(doc, 'obsidian')
    expect(invoke.mock.calls[0][1].text).not.toContain('abcdef1234567890SECRET')
    expect(out).toMatchObject({ ok: true, redactions: 2 })
  })

  it('reports a cancelled save dialog as cancelled, not as an error', async () => {
    invoke.mockResolvedValue(null)
    expect(await exportDocument(doc, 'markdown')).toEqual({ ok: false, cancelled: true })
  })

  it('reports a backend failure as a message', async () => {
    invoke.mockRejectedValue({ message: 'disk full' })
    expect(await exportDocument(doc, 'markdown')).toEqual({
      ok: false,
      cancelled: false,
      message: 'disk full',
    })
  })

  it('saves an image as base64 png', async () => {
    renderPng.mockResolvedValue({ ok: true, base64: 'AAAA', width: 1, height: 1 })
    invoke.mockResolvedValue({ path: 'x.png', redactions: 0 })
    await exportDocument(doc, 'image')
    expect(invoke.mock.calls[0][1]).toMatchObject({ ext: 'png', base64: 'AAAA' })
  })

  it('refuses an image that is too tall without calling the backend', async () => {
    renderPng.mockResolvedValue({ ok: false, message: 'too long' })
    expect(await exportDocument(doc, 'image')).toEqual({
      ok: false,
      cancelled: false,
      message: 'too long',
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('opens the print dialog for PDF and has no path to report', async () => {
    printDocument.mockResolvedValue('printed')
    const out = await exportDocument(doc, 'pdf')
    expect(out).toMatchObject({ ok: true, path: null, kind: 'print' })
    expect(invoke).not.toHaveBeenCalled()
    expect(printDocument.mock.calls[0][0].messages[0].text).not.toContain('SECRET')
  })

  it('passes the view through', async () => {
    invoke.mockResolvedValue({ path: 'p.md', redactions: 0 })
    await exportDocument(
      { ...doc, messages: [{ role: 'assistant', text: '', tools: [{ name: 't', output: 'BODY' }] }] },
      'markdown',
      { view: 'verbose' }
    )
    expect(invoke.mock.calls[0][1].text).toContain('BODY')
  })
})

describe('PDF fallback', () => {
  it('saves a print-ready html file when the webview cannot print', async () => {
    printDocument.mockResolvedValue('unavailable')
    invoke.mockResolvedValue({ path: 'C:\out\Notes.html', redactions: 0 })
    const out = await exportDocument(doc, 'pdf')
    expect(out).toMatchObject({ ok: true, kind: 'html', path: 'C:\out\Notes.html' })
    expect(invoke.mock.calls[0][1]).toMatchObject({
      ext: 'html',
      suggestedName: 'Notes- a-b.html',
      text: '<html>page</html>',
    })
  })

  it('skips printing entirely when the strategy is html', async () => {
    invoke.mockResolvedValue({ path: 'x.html', redactions: 0 })
    const out = await exportDocument(doc, 'pdf', { pdf: 'html' })
    expect(printDocument).not.toHaveBeenCalled()
    expect(out).toMatchObject({ ok: true, kind: 'html' })
  })

  it('is cancelled, not saved, when the fallback dialog is dismissed', async () => {
    printDocument.mockResolvedValue('unavailable')
    invoke.mockResolvedValue(null)
    expect(await exportDocument(doc, 'pdf')).toEqual({ ok: false, cancelled: true })
  })
})

describe('size cap', () => {
  it('names the limit and what to do', () => {
    expect(sizeProblem(MAX_EXPORT_BYTES)).toBeNull()
    expect(sizeProblem(MAX_EXPORT_BYTES + 1)).toMatch(/50 MB.*single message/)
  })

  it('refuses a huge export before calling the backend', async () => {
    const big: ExportDoc = {
      ...doc,
      messages: [{ role: 'assistant', text: 'x'.repeat(MAX_EXPORT_BYTES + 10) }],
    }
    const out = await exportDocument(big, 'markdown')
    expect(out).toMatchObject({ ok: false, cancelled: false })
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('redactDoc', () => {
  it('leaves a clean document untouched', () => {
    expect(redactDoc({ ...doc, messages: [{ role: 'user', text: 'hello' }] }).redactions).toBe(0)
  })
})
