/**
 * Run an export from a menu or the command palette and tell the user how it
 * went. Kept apart from `exportFile.ts` so that module stays free of the UI.
 */
import { toast } from 'sonner'
import { exportDocument, type ExportFormat } from '@/lib/exportFile'
import type { ExportDoc, ExportView } from '@/lib/exportMarkdown'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** The choices a menu offers: a format, and how much of the run it shows. */
export type ExportChoice = {
  id: string
  format: ExportFormat
  view: ExportView
  labelKey: string
}

export const EXPORT_CHOICES: readonly ExportChoice[] = [
  { id: 'markdown', format: 'markdown', view: 'default', labelKey: 'common:export.markdown' },
  { id: 'markdown-full', format: 'markdown', view: 'verbose', labelKey: 'common:export.markdownFull' },
  { id: 'obsidian', format: 'obsidian', view: 'default', labelKey: 'common:export.obsidian' },
  { id: 'pdf', format: 'pdf', view: 'default', labelKey: 'common:export.pdf' },
  { id: 'image', format: 'image', view: 'default', labelKey: 'common:export.image' },
]

export type BuildDoc = () => ExportDoc | null | Promise<ExportDoc | null>

export async function runExport(
  build: BuildDoc,
  choice: Pick<ExportChoice, 'format' | 'view'>,
  t: Translate
): Promise<void> {
  let doc: ExportDoc | null
  try {
    doc = await build()
  } catch (e) {
    toast.error(
      t('common:export.failed', { reason: e instanceof Error ? e.message : String(e) })
    )
    return
  }
  if (!doc) {
    toast.error(t('common:export.nothing'))
    return
  }
  const out = await exportDocument(doc, choice.format, { view: choice.view })
  if (out.ok) {
    const saved =
      out.path === null
        ? t('common:export.printOpened')
        : t('common:export.saved', { path: out.path })
    toast.success(
      out.redactions > 0
        ? `${saved} ${t('common:export.redacted', { count: out.redactions })}`
        : saved
    )
  } else if (!out.cancelled) {
    toast.error(t('common:export.failed', { reason: out.message }))
  }
}
