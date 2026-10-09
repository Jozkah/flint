/**
 * Folder tree for a project's files, derived from the original path each file
 * was attached from (already stored with the record, so nothing to migrate).
 * The directories every file shares are dropped, so a dropped folder shows as
 * its own contents rather than as `C:\Users\you\Documents\...`.
 */

export type TreeFile<T> = { kind: 'file'; file: T }
export type TreeFolder<T> = {
  kind: 'folder'
  /** Path of folder names from the shared root, joined with `/`; unique. */
  id: string
  name: string
  children: TreeNode<T>[]
}
export type TreeNode<T> = TreeFile<T> | TreeFolder<T>

const dirSegments = (path: string | undefined): string[] => {
  if (!path) return []
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.slice(0, -1)
}

export function buildProjectFileTree<T extends { path?: string }>(
  files: T[]
): { nodes: TreeNode<T>[]; hasFolders: boolean } {
  const withPath = files.filter((f) => f.path)
  let common: string[] = []
  if (withPath.length > 0) {
    common = dirSegments(withPath[0].path)
    for (const f of withPath.slice(1)) {
      const segs = dirSegments(f.path)
      let i = 0
      while (i < common.length && i < segs.length && common[i] === segs[i]) i++
      common = common.slice(0, i)
    }
  }

  const root: TreeNode<T>[] = []
  let hasFolders = false
  for (const file of files) {
    const rel = dirSegments(file.path).slice(common.length)
    let level = root
    let id = ''
    for (const name of rel) {
      id = id ? `${id}/${name}` : name
      let folder = level.find(
        (n): n is TreeFolder<T> => n.kind === 'folder' && n.name === name
      )
      if (!folder) {
        folder = { kind: 'folder', id, name, children: [] }
        level.push(folder)
        hasFolders = true
      }
      level = folder.children
    }
    level.push({ kind: 'file', file })
  }
  return { nodes: root, hasFolders }
}
