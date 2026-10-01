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
import { printDocument, renderPng } from '@/lib/exportRender'

export type ExportFormat = 'markdown' | 'obsidian' | 'pdf' | 'image'

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  'markdown',
  'obsidian',
  'pdf',
  'image',
]

export type ExportOutcome =
  | { ok: true; path: string | null; redactions: number }
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
  options: { view?: ExportView } = {}
): Promise<ExportOutcome> {
  try {
    const { doc, redactions } = redactDoc(source)
    const render = { view: options.view }

    if (format === 'pdf') {
      await printDocument(doc, render)
      return { ok: true, path: null, redactions }
    }

    let report: SaveReport
    if (format === 'image') {
      const image = await renderPng(doc, render)
      if (!image.ok) return { ok: false, cancelled: false, message: image.message }
      report = await invoke<SaveReport>('export_save_file', {
        ext: 'png',
        suggestedName: exportFileName(doc.title, 'png'),
        base64: image.base64,
      })
    } else {
      const text =
        format === 'obsidian' ? renderObsidian(doc, render) : renderMarkdown(doc, render)
      report = await invoke<SaveReport>('export_save_file', {
        ext: 'md',
        suggestedName: exportFileName(doc.title, 'md'),
        text,
      })
    }
    if (!report) return { ok: false, cancelled: true }
    return { ok: true, path: report.path, redactions: redactions + report.redactions }
  } catch (e) {
    return { ok: false, cancelled: false, message: errorText(e) }
  }
}
