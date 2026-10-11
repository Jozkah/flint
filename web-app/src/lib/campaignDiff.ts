/**
 * What a campaign task changed, as the board shows it (docs/CAMPAIGNS.md).
 * Pure formatting over `agent_campaign_task_diff`; the backend does the git.
 */
import type { TaskDiff, TaskDiffFile } from '@/lib/campaignApi'

export type ChangeKind = 'new' | 'edited' | 'deleted' | 'renamed'

export function kindOf(file: Pick<TaskDiffFile, 'status'>): ChangeKind {
  switch (file.status) {
    case 'added':
      return 'new'
    case 'deleted':
      return 'deleted'
    case 'renamed':
      return 'renamed'
    default:
      return 'edited'
  }
}

/** "+14 −3", with a real minus sign so the two read as a pair. */
export function lineCounts(added: number, removed: number): string {
  return `+${added} −${removed}`
}

export type DiffTotals = {
  files: number
  added: number
  removed: number
}

/** Totals from the files themselves, so they always match the list. */
export function totalsOf(diff: Pick<TaskDiff, 'files'>): DiffTotals {
  return {
    files: diff.files.length,
    added: diff.files.reduce((n, f) => n + f.added, 0),
    removed: diff.files.reduce((n, f) => n + f.removed, 0),
  }
}

/**
 * A diff built from the file names the session's tool activity recorded, for
 * when git cannot be asked (the worktree is gone, or not recorded yet). It
 * has names and nothing else, which `counted` says.
 */
export function fallbackDiff(paths: readonly string[]): TaskDiff & {
  counted: false
} {
  return {
    files: paths.map((path) => ({
      path,
      status: 'modified' as const,
      added: 0,
      removed: 0,
      binary: false,
      truncated: false,
    })),
    added: 0,
    removed: 0,
    truncated: false,
    uncommitted: false,
    counted: false,
  }
}

/** Lines shown before a patch asks to be expanded. */
export const PREVIEW_LINES = 40

/**
 * The first `max` lines of a patch and how many were held back, so a long diff
 * opens short and "show more" has a number to put on its button.
 */
export function previewPatch(
  patch: string,
  max = PREVIEW_LINES
): { text: string; hidden: number } {
  const lines = patch.split('\n')
  if (lines.length <= max) return { text: patch, hidden: 0 }
  return { text: lines.slice(0, max).join('\n'), hidden: lines.length - max }
}

/** The directory part and file name of a path, for a quiet-then-bold row. */
export function splitPath(path: string): { dir: string; name: string } {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}

/**
 * Several tasks' diffs as the campaign's one: a file two tasks touched is
 * listed once (the later task's patch, the lines of both counted), and the
 * totals are over that list.
 */
export function mergeTaskDiffs(diffs: readonly TaskDiff[]): TaskDiff {
  const byPath = new Map<string, TaskDiffFile>()
  for (const d of diffs) {
    for (const f of d.files) {
      const before = byPath.get(f.path)
      byPath.set(
        f.path,
        before
          ? {
              ...f,
              added: before.added + f.added,
              removed: before.removed + f.removed,
              truncated: before.truncated || f.truncated,
            }
          : f
      )
    }
  }
  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  return {
    files,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    truncated: diffs.some((d) => d.truncated),
    uncommitted: diffs.some((d) => d.uncommitted),
  }
}
