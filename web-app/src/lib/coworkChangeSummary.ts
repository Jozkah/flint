/**
 * What this session changed -- and only what it changed.
 *
 * The working tree of an attached repository usually has edits in it that
 * nobody asked Flint about: a half-finished branch, a config someone tweaked an
 * hour ago. Counting those as change activity tells the user Flint wrote 40
 * files when it wrote two, which is worse than showing nothing: it is a claim
 * about authorship that is false.
 *
 * So a repository file counts only when this session wrote to that path. In
 * the sandbox that is the diff Flint produced; in a directly-edited checkout it
 * is the same write turn, landing somewhere Git can see.
 */
import type { CoworkFileDiff } from '@/lib/coworkDiffs'
import type { GitStatus } from '@/lib/coworkGit'

export type ChangeCounts = {
  fileCount: number
  additions: number
  deletions: number
}

/**
 * Whether a repository-relative path is one of the paths Flint wrote.
 *
 * Git reports paths relative to the repository root; a tool call may name an
 * absolute path, a path relative to the attached folder, or the same file
 * through a worktree. Comparing from the right-hand end matches all of those
 * without treating `src/app.ts` and `vendor/src/app.ts` as the same file,
 * which a bare basename comparison would.
 */
export function pathsMatch(gitPath: string, writtenPath: string): boolean {
  const a = gitPath.replace(/\\/g, '/').replace(/^\.\//, '')
  const b = writtenPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (a === b) return true
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

export function janAuthoredChanges(
  diffs: CoworkFileDiff[],
  git: GitStatus | null | undefined
): ChangeCounts {
  const counts: ChangeCounts = {
    fileCount: diffs.length,
    additions: diffs.reduce((sum, d) => sum + d.additions, 0),
    deletions: diffs.reduce((sum, d) => sum + d.deletions, 0),
  }

  // A file Flint wrote whose own diff carried no line counts -- a direct edit
  // the tool reported without one -- is still Flint's change, and Git knows how
  // big it was. Everything else in the working tree belongs to whoever wrote
  // it and is not this session's to report.
  for (const file of git?.files ?? []) {
    const written = diffs.find((d) => pathsMatch(file.path, d.path))
    if (!written) continue
    if (written.additions === 0 && written.deletions === 0) {
      counts.additions += file.additions
      counts.deletions += file.deletions
    }
  }

  return counts
}

/** `3 files changed · +24 −8`, or `1 file changed · +2 −0`. */
export function formatChangeSummary(counts: ChangeCounts): string {
  const files = `${counts.fileCount} ${counts.fileCount === 1 ? 'file' : 'files'} changed`
  // A true minus sign, not a hyphen: these sit next to each other in a
  // tabular row and the hyphen reads as a dash in a sentence.
  return `${files} · +${counts.additions} −${counts.deletions}`
}
