/**
 * Export a conversation to a file the user chooses.
 *
 * The renderer only supplies content and a suggested name; the backend opens
 * its own save dialog (`export_save_file`), so no path comes from here.
 * Credentials are redacted before the content leaves this module and the
 * backend redacts Markdown again. PDF goes through the system print dialog
 * instead, where the user picks "Save as PDF" or a printer, so there is no
 * path to report for it.
 */
import { invoke } from '@tauri-apps/api/core'
import { errorText } from '@/lib/errorText'
import { redactSecrets } from '@/lib/redact'
import {
  exportFileName,
  renderMarkdown,
  renderObsidian,
  type ExportDoc,
  type ExportView,
} from '@/lib/exportMarkdown'
import {
  currentPdfStrategy,
  printDocument,
  renderHtmlPage,
  renderPng,
  type PdfStrategy,
} from '@/lib/exportRender'

/** The backend refuses more than this; refuse here first, with a reason. */
export const MAX_EXPORT_BYTES = 50 * 1024 * 1024

/** A message for content the backend would refuse, or null when it fits. */
export function sizeProblem(bytes: number): string | null {
  if (bytes <= MAX_EXPORT_BYTES) return null
  const mb = (bytes / (1024 * 1024)).toFixed(0)
  return `this export is ${mb} MB and the limit is 50 MB; export a single message or branch, or leave out tool details`
}

const textBytes = (text: string) => new TextEncoder().encode(text).length
/** Decoded size of a base64 string. */
const base64Bytes = (data: string) => Math.floor((data.length * 3) / 4)

export type ExportFormat = 'markdown' | 'obsidian' | 'pdf' | 'image'

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  'markdown',
  'obsidian',
  'pdf',
  'image',
]

/**
 * How a successful export ended: `file` was written where the user chose,
 * `print` handed the document to the print dialog (nothing is saved yet), and
 * `html` is the PDF fallback, a print-ready page the user prints themselves.
 */
export type ExportKind = 'file' | 'print' | 'html'

export type ExportOutcome =
  | { ok: true; path: string | null; redactions: number; kind: ExportKind }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; message: string }

/** Redact every string in `value`, counting the strings that changed. */
function scrub<T>(value: T, count: { n: number }): T {
  if (typeof value === 'string') {
    const cleaned = redactSecrets(value)
    if (cleaned !== value) count.n += 1
    return cleaned as T
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, count)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, count)
    return out as T
  }
  return value
}

/** The document with credentials removed, and how many places had one. */
export function redactDoc(doc: ExportDoc): { doc: ExportDoc; redactions: number } {
  const count = { n: 0 }
  return { doc: scrub(doc, count), redactions: count.n }
}

type SaveReport = { path: string; redactions: number } | null

export async function exportDocument(
  source: ExportDoc,
  format: ExportFormat,
  options: { view?: ExportView; pdf?: PdfStrategy } = {}
): Promise<ExportOutcome> {
  try {
    const { doc, redactions } = redactDoc(source)
    const render = { view: options.view }

    let asHtml = false
    if (format === 'pdf') {
      const strategy = options.pdf ?? currentPdfStrategy()
      if (strategy === 'print') {
        const result = await printDocument(doc, render)
        if (result === 'printed') return { ok: true, path: null, redactions, kind: 'print' }
      }
      asHtml = true
    }

    let report: SaveReport
    if (asHtml) {
      const html = renderHtmlPage(doc, render)
      const tooBig = sizeProblem(textBytes(html))
      if (tooBig) return { ok: false, cancelled: false, message: tooBig }
      report = await invoke<SaveReport>('export_save_file', {
        ext: 'html',
        suggestedName: exportFileName(doc.title, 'html'),
        text: html,
      })
    } else if (format === 'image') {
      const image = await renderPng(doc, render)
      if (!image.ok) return { ok: false, cancelled: false, message: image.message }
      const tooBig = sizeProblem(base64Bytes(image.base64))
      if (tooBig) return { ok: false, cancelled: false, message: tooBig }
      report = await invoke<SaveReport>('export_save_file', {
        ext: 'png',
        suggestedName: exportFileName(doc.title, 'png'),
        base64: image.base64,
      })
    } else {
      const text =
        format === 'obsidian' ? renderObsidian(doc, render) : renderMarkdown(doc, render)
      const tooBig = sizeProblem(textBytes(text))
      if (tooBig) return { ok: false, cancelled: false, message: tooBig }
      report = await invoke<SaveReport>('export_save_file', {
        ext: 'md',
        suggestedName: exportFileName(doc.title, 'md'),
        text,
      })
    }
    if (!report) return { ok: false, cancelled: true }
    return {
      ok: true,
      path: report.path,
      redactions: redactions + report.redactions,
      kind: asHtml ? 'html' : 'file',
    }
  } catch (e) {
    return { ok: false, cancelled: false, message: errorText(e) }
  }
}
