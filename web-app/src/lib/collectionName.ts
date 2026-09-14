/**
 * Does this collection name look like somebody trying to open a folder?
 *
 * A collection groups conversations and reference files. It is named, not
 * attached: typing a path here has never opened that folder and never will.
 * But the old label said "Project", and a person who types
 * `D:\Code\obs-forwarder` into something called New Project has every reason
 * to believe they just pointed Flint at a repository — which is how a session
 * ends up talking about a folder nobody selected.
 *
 * So the name is inspected, and when it reads as a path the UI says plainly
 * what it did and offers the thing the person actually wanted.
 *
 * Deliberately generous about what counts: the cost of a false positive is one
 * extra sentence next to a text field, and the cost of a miss is the
 * misunderstanding this exists to prevent.
 */
export function looksLikeFilesystemPath(name: string): boolean {
  const value = name.trim()
  if (value.length === 0) return false

  // `C:\src`, `D:/code` — a drive letter is unambiguous.
  if (/^[a-z]:[\\/]/i.test(value)) return true
  // `\\server\share`
  if (value.startsWith('\\\\')) return true
  // POSIX absolute, and the shell shorthands people type for one.
  if (value.startsWith('/')) return true
  if (value.startsWith('~/') || value === '~') return true
  if (value.startsWith('./') || value.startsWith('../')) return true
  if (value.startsWith('.\\') || value.startsWith('..\\')) return true
  // `file:///Users/...`
  if (/^file:\/\//i.test(value)) return true

  // A bare relative path — `src/components`, `Code\obs-forwarder`. Requires a
  // separator with something either side, so an ordinary title that happens to
  // contain a slash ("Research / notes") is left alone by the surrounding
  // spaces rather than by luck.
  return /^[^\s\\/]+[\\/][^\s\\/]+/.test(value)
}
