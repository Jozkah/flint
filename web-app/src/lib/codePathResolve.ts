/**
 * Which Code panel tab a path from a tool call names, resolved the way the
 * tools resolve it.
 *
 * - An absolute path belongs to the tree the session works in (the managed
 *   worktree, or the attached folder), or to the session sandbox.
 * - A relative path is where the backend put it: under the write root when
 *   the session holds a live grant (the backend rebases relative paths there),
 *   and in the session sandbox otherwise.
 *
 * Anything else is refused with a reason, which becomes the tooltip, rather
 * than opened as a guess.
 */
import { relativeToRoot, shouldOpenInCode } from '@/lib/coworkCode'
import { isInsideAnyFolder } from '@/lib/coworkFolders'

export type UnresolvedReason =
  /** Not source the Code panel shows (an image, a binary, a directory). */
  | 'not-source'
  /** Outside every root the session has. */
  | 'outside'
  /** In an extra attached folder, which the Code panel does not browse. */
  | 'extra-folder'
  /** No session to hold a sandbox tab yet. */
  | 'no-session'

export type ResolvedCodePath =
  | { kind: 'project'; rel: string }
  | { kind: 'sandbox'; rel: string }
  | { kind: 'unresolved'; reason: UnresolvedReason }

const isAbsolute = (path: string) => /^([a-zA-Z]:[\\/]|[\\/])/.test(path)

export function resolveCodePath(
  path: string,
  ctx: {
    /** The tree project tabs are read from. */
    treeRoot: string | null
    workspacePath: string | null
    extraFolders?: readonly string[]
    /** Relative paths land in the write root (a live grant), not the sandbox. */
    relativeIsProject: boolean
    hasSession: boolean
  }
): ResolvedCodePath {
  const trimmed = path.trim()
  if (!trimmed || !shouldOpenInCode(trimmed)) {
    return { kind: 'unresolved', reason: 'not-source' }
  }
  if (isAbsolute(trimmed)) {
    if (ctx.treeRoot) {
      const rel = relativeToRoot(ctx.treeRoot, trimmed)
      if (rel !== trimmed) return { kind: 'project', rel }
    }
    if (ctx.workspacePath) {
      const rel = relativeToRoot(ctx.workspacePath, trimmed)
      if (rel !== trimmed) {
        return ctx.hasSession
          ? { kind: 'sandbox', rel }
          : { kind: 'unresolved', reason: 'no-session' }
      }
    }
    if (isInsideAnyFolder(ctx.extraFolders ?? [], trimmed)) {
      return { kind: 'unresolved', reason: 'extra-folder' }
    }
    return { kind: 'unresolved', reason: 'outside' }
  }
  const rel = trimmed.replace(/\\/g, '/').replace(/^\.\//, '')
  if (ctx.relativeIsProject && ctx.treeRoot) return { kind: 'project', rel }
  if (!ctx.hasSession) return { kind: 'unresolved', reason: 'no-session' }
  return { kind: 'sandbox', rel }
}

/**
 * How a tool's path is shown: relative to the sandbox or folder it resolved
 * into, else only the file name. Tool calls carry absolute paths deep in the
 * data folder, which crowded out the part that says which file it is.
 */
export function shortToolPath(
  resolved: ResolvedCodePath,
  path: string,
  /** Other attached folders, which the Code panel does not browse. */
  folders: readonly string[] = []
): string {
  if (resolved.kind !== 'unresolved' && resolved.rel) return resolved.rel
  for (const folder of folders) {
    const rel = relativeToRoot(folder, path)
    if (rel && rel !== path) return rel
  }
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/**
 * The full path of a file listed in Changes, for opening it outside Flint.
 * A Git row is relative to the tree the changes are in; a session row is the
 * path the run wrote, absolute or relative to wherever it resolved.
 */
export function absoluteChangePath(
  path: string,
  source: 'git' | 'session',
  roots: {
    treeRoot: string | null
    workspacePath: string | null
    resolved: ResolvedCodePath
  }
): string | null {
  if (isAbsolute(path)) return path
  const join = (root: string | null, rel: string) =>
    root ? `${root.replace(/[\\/]+$/, '')}/${rel.replace(/^\.\//, '')}` : null
  if (source === 'git') return join(roots.treeRoot, path)
  const { resolved } = roots
  if (resolved.kind === 'sandbox') return join(roots.workspacePath, resolved.rel)
  if (resolved.kind === 'project') return join(roots.treeRoot, resolved.rel)
  return null
}
