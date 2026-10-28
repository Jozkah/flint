import type { CoworkFileDiff } from '@/lib/coworkDiffs'
import { type GitFileEntry } from '@/lib/coworkGit'

/** Tint a status tile by kind: added green, deleted red, modified amber. */
export function statusColor(status: GitFileEntry['status']): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'bg-success-tint text-success'
    case 'deleted':
      return 'bg-destructive-tint text-destructive'
    case 'modified':
    case 'type_changed':
    case 'unmerged':
      return 'bg-warning-tint text-warning'
    default:
      return 'bg-muted text-fg-2'
  }
}

export type SessionGroup = {
  key: string
  title: string
  files: CoworkFileDiff[]
  /** The row label: in-place paths are shown relative to their folder. */
  show: (path: string) => string
}

const splitPath = (path: string) => path.split(/[\\/]/).filter(Boolean)

/** The deepest folder every path shares, as segments. */
function commonFolder(paths: readonly string[]): string[] {
  const split = paths.map((p) => splitPath(p).slice(0, -1))
  const first = split[0] ?? []
  let n = 0
  while (n < first.length && split.every((s) => s[n] === first[n])) n += 1
  return first.slice(0, n)
}

export function groupSessionFiles(
  files: CoworkFileDiff[],
  isSandboxPath: ((path: string) => boolean) | undefined,
  t: (key: string, vars?: Record<string, unknown>) => string,
  displayPath?: (path: string) => string
): SessionGroup[] {
  const inSandbox = files.filter((f) => !isSandboxPath || isSandboxPath(f.path))
  const inPlace = files.filter((f) => isSandboxPath && !isSandboxPath(f.path))
  const groups: SessionGroup[] = []
  if (inPlace.length > 0) {
    const common = commonFolder(inPlace.map((f) => f.path))
    const folder = common[common.length - 1]
    groups.push({
      key: 'in-place',
      title: folder
        ? t('common:changes.changedIn', { folder })
        : t('common:changes.changedInPlace'),
      files: inPlace,
      show: (path) => splitPath(path).slice(common.length).join('/') || path,
    })
  }
  if (inSandbox.length > 0) {
    groups.push({
      key: 'sandbox',
      title: t('common:changes.sandboxOutput'),
      files: inSandbox,
      show: (path) => displayPath?.(path) ?? path,
    })
  }
  return groups
}
