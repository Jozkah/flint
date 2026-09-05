/**
 * Deciding which of the user's own directories Jan may read skills from.
 *
 * A user-level skill directory sits outside every repository, so none of the
 * containment that protects the attached folder applies to it. What protects
 * the user here is that the list is theirs: a root arrives from the native
 * directory picker, one at a time, and a repository can never name one. A
 * `CLAUDE.md` that could add a discovery root would be a file in a repository
 * choosing which of the user's directories Jan reads — which is the whole
 * attack this module exists to make impossible.
 *
 * The rules below are about the second question: given that the user picked
 * it, is this directory a sensible place to read skills from at all.
 */

/** Why a directory cannot be used as a skill root. */
export type RootRejection =
  /** A filesystem root or a drive letter: far too broad to scan. */
  | 'too-broad'
  /** Jan's own storage. Not the user's skills, and not ours to expose. */
  | 'jan-data'
  /** Already approved, or inside a root that is. */
  | 'duplicate'
  /** Contains an approved root, which would swallow it. */
  | 'overlaps'
  /** Nothing there, or not a directory. */
  | 'missing'

export type RootCheck =
  | { ok: true; path: string }
  | { ok: false; reason: RootRejection }

/** Normalize for comparison: forward slashes, no trailing separator. */
const normalize = (path: string): string =>
  path.replace(/\\/g, '/').replace(/\/+$/, '')

/**
 * Component-wise containment.
 *
 * `/home/dev/skills-backup` is not inside `/home/dev/skills`, and a string
 * prefix test says it is. Same failure as everywhere else in this surface.
 */
const inside = (parent: string, child: string): boolean => {
  const p = normalize(parent)
  const c = normalize(child)
  return c === p || c.startsWith(`${p}/`)
}

/** A path with no directory component left to scan. */
const isFilesystemRoot = (path: string): boolean => {
  const p = normalize(path)
  return p === '' || p === '/' || /^[a-z]:$/i.test(p)
}

/**
 * May this directory be approved as a skill root?
 *
 * `exists` comes from the backend, which is the only thing that can tell a
 * directory from a file or from something that is not there — the picker can
 * return a path that has since been removed or unmounted.
 */
export function checkRoot(
  candidate: string,
  opts: {
    approved: readonly string[]
    /** Jan's data folder, when known. */
    janData?: string | null
    /** Did the backend confirm this is a directory that exists? */
    exists: boolean
  }
): RootCheck {
  const path = normalize(candidate)

  if (isFilesystemRoot(path)) return { ok: false, reason: 'too-broad' }
  if (!opts.exists) return { ok: false, reason: 'missing' }
  if (opts.janData && inside(opts.janData, path)) {
    return { ok: false, reason: 'jan-data' }
  }
  // Already covered by something approved — adding it would scan the same
  // skills twice and report every one of them as a duplicate of itself.
  if (opts.approved.some((one) => inside(one, path))) {
    return { ok: false, reason: 'duplicate' }
  }
  // The other direction: approving a parent of an approved root would swallow
  // it, and the user would lose the narrower choice they had already made.
  if (opts.approved.some((one) => inside(path, one))) {
    return { ok: false, reason: 'overlaps' }
  }
  return { ok: true, path }
}

/** Add an approved root, or report why not. Never mutates its input. */
export function addRoot(
  approved: readonly string[],
  candidate: string,
  opts: { janData?: string | null; exists: boolean }
): { roots: string[]; rejected?: RootRejection } {
  const check = checkRoot(candidate, { approved, ...opts })
  if (!check.ok) return { roots: [...approved], rejected: check.reason }
  return { roots: [...approved, check.path] }
}

/** Withdraw a root. Future runs stop reading it; a live run keeps its manifest. */
export const removeRoot = (
  approved: readonly string[],
  path: string
): string[] => approved.filter((one) => normalize(one) !== normalize(path))
