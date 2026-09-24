import type { FileStat } from '@janhq/core'

/** The two filesystem calls the walk needs, as `@janhq/core`'s `fs` has them. */
export type WalkFs = {
  readdirSync: (path: string) => Promise<string[]>
  fileStat: (path: string) => Promise<FileStat | undefined>
}

/**
 * Deepest directory level the walk descends to. A folder a user drops in is
 * never this deep; a cycle the symlink check cannot see (a junction reported
 * as a plain directory, say) is stopped here instead of recursing forever.
 */
export const MAX_WALK_DEPTH = 32

/**
 * Every file under `dirPath` that `accept` keeps. Symlinked directories are
 * not followed: a link back to an ancestor would otherwise recurse without
 * end (#174). Unreadable directories are skipped with a warning.
 */
export async function collectFilesFromDirectory(
  dirPath: string,
  fs: WalkFs,
  accept: (path: string) => boolean,
  depth = 0
): Promise<string[]> {
  const files: string[] = []
  if (depth > MAX_WALK_DEPTH) {
    console.warn(`Not descending past ${MAX_WALK_DEPTH} levels at ${dirPath}`)
    return files
  }
  try {
    const entries = await fs.readdirSync(dirPath)
    for (const entry of entries) {
      const stat = await fs.fileStat(entry)
      if (stat?.isDirectory) {
        if (stat.isSymlink) continue
        files.push(
          ...(await collectFilesFromDirectory(entry, fs, accept, depth + 1))
        )
      } else if (accept(entry)) {
        files.push(entry)
      }
    }
  } catch (e) {
    console.warn(`Failed to read directory ${dirPath}:`, e)
  }
  return files
}
