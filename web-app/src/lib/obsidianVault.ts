import { useEffect, useState } from 'react'

/**
 * An Obsidian vault is an ordinary folder of Markdown files. Obsidian marks it
 * by keeping a `.obsidian` folder (its settings) at the top, and its own
 * deleted notes go to `.trash`. Flint treats a vault like any other attached
 * folder; this only recognises one so it can say so, and the file browser and
 * `@` picker leave `.obsidian` and `.trash` out (backend, `project_browse`).
 */
export const OBSIDIAN_DIR = '.obsidian'

/** The one filesystem call the check needs, as `@janhq/core`'s `fs` has it. */
export type VaultFs = {
  fileStat: (path: string) => Promise<{ isDirectory?: boolean } | undefined>
}

/** Join a folder and a child with the folder's own separator style. */
function child(path: string, name: string): string {
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  return `${path.replace(/[\\/]+$/, '')}${sep}${name}`
}

/**
 * Whether `path` is the top of an Obsidian vault. Read-only: a single stat of
 * `<path>/.obsidian`. Any failure is "no".
 */
export async function isObsidianVault(
  path: string | null | undefined,
  fs: VaultFs
): Promise<boolean> {
  if (!path) return false
  try {
    const stat = await fs.fileStat(child(path, OBSIDIAN_DIR))
    return stat?.isDirectory === true
  } catch {
    return false
  }
}

/** React wrapper: true once `folder` is known to be a vault. */
export function useObsidianVault(folder: string | null | undefined): boolean {
  const [isVault, setIsVault] = useState(false)
  useEffect(() => {
    let alive = true
    setIsVault(false)
    if (!folder) return
    void (async () => {
      try {
        const { fs } = await import('@janhq/core')
        const found = await isObsidianVault(folder, fs)
        if (alive) setIsVault(found)
      } catch {
        // Outside the desktop app there is no filesystem to ask.
      }
    })()
    return () => {
      alive = false
    }
  }, [folder])
  return isVault
}
