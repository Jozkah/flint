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
  /** Nest the other versions of edited or regenerated messages (threads only). */
  allVersions?: boolean
}

export const EXPORT_CHOICES: readonly ExportChoice[] = [
  { id: 'markdown', format: 'markdown', view: 'default', labelKey: 'common:export.markdown' },
  { id: 'markdown-full', format: 'markdown', view: 'verbose', labelKey: 'common:export.markdownFull' },
  { id: 'obsidian', format: 'obsidian', view: 'default', labelKey: 'common:export.obsidian' },
  { id: 'markdown-versions', format: 'markdown', view: 'default', labelKey: 'common:export.markdownVersions', allVersions: true },
  { id: 'obsidian-versions', format: 'obsidian', view: 'default', labelKey: 'common:export.obsidianVersions', allVersions: true },
  { id: 'pdf', format: 'pdf', view: 'default', labelKey: 'common:export.pdf' },
  { id: 'image', format: 'image', view: 'default', labelKey: 'common:export.image' },
]

export type BuildOptions = { allVersions: boolean }

export type BuildDoc = (
  options: BuildOptions
) => ExportDoc | null | Promise<ExportDoc | null>

export async function runExport(
  build: BuildDoc,
  choice: Pick<ExportChoice, 'format' | 'view' | 'allVersions'>,
  t: Translate
): Promise<void> {
  let doc: ExportDoc | null
  try {
    doc = await build({ allVersions: choice.allVersions === true })
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
      out.kind === 'print'
        ? t('common:export.printOpened')
        : out.kind === 'html'
          ? t('common:export.htmlSaved', { path: out.path })
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
