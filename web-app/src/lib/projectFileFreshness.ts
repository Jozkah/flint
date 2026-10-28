import type { AttachmentFileInfo, FileStat } from '@janhq/core'
import { toast } from 'sonner'
import i18n from '@/i18n'

/**
 * Whether a project file's source on disk still matches the indexed copy.
 *
 * - `fresh`: same size and modification time as when indexed.
 * - `changed`: the file was edited since it was indexed.
 * - `missing`: the file is gone from disk.
 * - `unknown`: cannot tell (indexed before mtimes were stored, no path, or the
 *   stat was refused). Shows no badge.
 */
export type ProjectFileFreshness = 'fresh' | 'changed' | 'missing' | 'unknown'

/** Result of stat'ing a source: its stat, `'missing'`, or `undefined` when unknown. */
export type SourceStat = FileStat | 'missing' | undefined

export function fileFreshness(
  file: Pick<AttachmentFileInfo, 'path' | 'size' | 'mtime'>,
  stat: SourceStat
): ProjectFileFreshness {
  if (!file.path || typeof file.mtime !== 'number') return 'unknown'
  if (stat === 'missing') return 'missing'
  if (!stat || stat.isDirectory) return 'unknown'
  if (typeof file.size === 'number' && stat.size !== file.size) return 'changed'
  if (typeof stat.modified === 'number' && stat.modified !== file.mtime) {
    return 'changed'
  }
  return 'fresh'
}

/** A refused read (outside the read grants) is not proof the file is gone. */
function isDenied(error: unknown): boolean {
  return String(
    error instanceof Error ? error.message : (error as string)
  ).includes('fs_read_denied')
}

/**
 * Stat one source. A refused read is `undefined`; any other failure, or an
 * empty answer, means the file is no longer there.
 */
export async function statSource(
  path: string,
  fileStat: (path: string) => Promise<FileStat | undefined>
): Promise<SourceStat> {
  try {
    const stat = await fileStat(path)
    return stat ?? 'missing'
  } catch (error) {
    return isDenied(error) ? undefined : 'missing'
  }
}

/** Freshness of every file that has a stored mtime, keyed by file id. */
export async function checkProjectFiles(
  files: AttachmentFileInfo[],
  fileStat: (path: string) => Promise<FileStat | undefined>
): Promise<Record<string, ProjectFileFreshness>> {
  const out: Record<string, ProjectFileFreshness> = {}
  await Promise.all(
    files.map(async (f) => {
      // Older rows have nothing to compare against: skip the stat entirely.
      if (!f.path || typeof f.mtime !== 'number') {
        out[f.id] = 'unknown'
        return
      }
      out[f.id] = fileFreshness(f, await statSource(f.path, fileStat))
    })
  )
  return out
}

/**
 * Re-index one project file: drop its old row and chunks, then ingest the
 * file again. Deleting first means the project never holds two copies.
 */
export async function reindexProjectFile(
  projectId: string,
  file: AttachmentFileInfo,
  deps: {
    deleteFile: (projectId: string, fileId: string) => Promise<void>
    ingest: (
      projectId: string,
      input: { path: string; name?: string; type?: string; size?: number }
    ) => Promise<unknown>
    fileStat: (path: string) => Promise<FileStat | undefined>
  }
): Promise<void> {
  if (!file.path) throw new Error(`No source path for '${file.name ?? file.id}'`)
  const stat = await deps.fileStat(file.path)
  if (!stat) throw new Error(`'${file.name ?? file.path}' is no longer on disk`)
  await deps.deleteFile(projectId, file.id)
  await deps.ingest(projectId, {
    path: file.path,
    name: file.name,
    type: file.type,
    size: stat.size,
  })
}

/** Projects already warned this session, so each chat opened does not re-toast. */
const warnedProjects = new Set<string>()

/**
 * When a project chat opens, tell the user once if any of its files changed
 * on disk or went missing since they were indexed. Never throws.
 */
export async function warnIfProjectFilesChanged(
  projectId: string,
  files: AttachmentFileInfo[]
): Promise<void> {
  if (warnedProjects.has(projectId)) return
  try {
    const { fs } = await import('@janhq/core')
    const status = await checkProjectFiles(files, fs.fileStat)
    const stale = Object.values(status).filter(
      (s) => s === 'changed' || s === 'missing'
    ).length
    if (stale === 0) return
    warnedProjects.add(projectId)
    toast.warning(i18n.t('common:projects.staleFilesNotice', { count: stale }))
  } catch {
    // A failed check must never get in the way of the chat.
  }
}

/** Test hook: forget which projects were warned. */
export function resetProjectFileWarnings(): void {
  warnedProjects.clear()
}
