/**
 * The command palette's entries and their ranking. AH-206.
 *
 * Everything is local: the entries are built from the app's own routes,
 * settings registry and conversations, and ranked in memory. Nothing is
 * fetched, and no query leaves the process.
 */
import Fuse from 'fuse.js'

export type PaletteSection = 'actions' | 'navigation' | 'settings' | 'threads'

export type PaletteCommand = {
  id: string
  title: string
  section: PaletteSection
  /** Shown beside the title: the page or thread it belongs to. */
  hint?: string
  keywords?: string[]
  run: () => void
}

/** Sections in the order they are shown when nothing has been typed. */
export const SECTION_ORDER: PaletteSection[] = [
  'actions',
  'navigation',
  'threads',
  'settings',
]

/** The formats the palette offers for the conversation on screen. */
export const EXPORT_COMMAND_FORMATS = [
  'markdown',
  'obsidian',
  'pdf',
  'image',
] as const

export type ExportCommandFormat = (typeof EXPORT_COMMAND_FORMATS)[number]

/**
 * "Export current chat as ..." entries. Offered only while a chat or a Cowork
 * session is on screen (`target`), since there is nothing else to export.
 */
export function exportCommands(
  target: 'thread' | 'session' | null,
  title: (format: ExportCommandFormat) => string,
  run: (target: 'thread' | 'session', format: ExportCommandFormat) => void
): PaletteCommand[] {
  if (!target) return []
  return EXPORT_COMMAND_FORMATS.map((format) => ({
    id: `action-export-${format}`,
    section: 'actions' as const,
    title: title(format),
    keywords: ['export', 'save', 'download', 'share', format],
    run: () => run(target, format),
  }))
}

/**
 * Rank commands against a query.
 *
 * With no query, every command is offered in section order, threads capped so
 * a long history does not bury the actions. With a query, results are ranked
 * by title first, then keywords and hint.
 */
export function rankCommands(
  commands: PaletteCommand[],
  query: string,
  limit = 50
): PaletteCommand[] {
  const trimmed = query.trim()
  if (!trimmed) {
    const out: PaletteCommand[] = []
    for (const section of SECTION_ORDER) {
      const inSection = commands.filter((c) => c.section === section)
      out.push(...(section === 'threads' ? inSection.slice(0, 5) : inSection))
    }
    return out.slice(0, limit)
  }
  const fuse = new Fuse(commands, {
    keys: [
      { name: 'title', weight: 0.7 },
      { name: 'keywords', weight: 0.2 },
      { name: 'hint', weight: 0.1 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
  })
  return fuse.search(trimmed, { limit }).map((r) => r.item)
}
