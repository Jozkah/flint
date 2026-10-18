import { toAssetUrl } from '@/lib/assetPath'

/**
 * Files named by path (a Linux drop or paste, see `transferFilePaths`), read
 * from disk into File objects so they take the same route as a real drop.
 *
 * A directory is never read: it is returned in `folders` so the caller can
 * offer it as the project, as a dropped folder is everywhere else.
 */
export async function readDroppedPaths(paths: string[]): Promise<{
  files: File[]
  folders: string[]
  failed: Array<{ path: string; error: string }>
}> {
  const files: File[] = []
  const folders: string[] = []
  const failed: Array<{ path: string; error: string }> = []
  for (const path of paths) {
    try {
      if (await isDirectory(path)) {
        folders.push(path)
        continue
      }
      const response = await fetch(await toAssetUrl(path))
      if (!response.ok) throw new Error(response.statusText || String(response.status))
      const blob = await response.blob()
      files.push(new File([blob], baseName(path), { type: blob.type }))
    } catch (error) {
      failed.push({
        path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { files, folders, failed }
}

export const baseName = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() || 'file'

async function isDirectory(path: string): Promise<boolean> {
  try {
    const { fs } = await import('@janhq/core')
    const stat = await fs.fileStat(path)
    return Boolean(stat?.isDirectory)
  } catch {
    return false
  }
}
