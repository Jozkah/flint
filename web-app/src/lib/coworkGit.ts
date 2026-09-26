// Client for the read-only git working-tree inspection commands
// (`agent_git_status`, `agent_git_file_diff`). The backend already emits
// camelCase and machine-parsed data; this module is a thin typed wrapper plus a
// few presentation helpers, kept store-free so the review panel and its tests
// can import it without pulling in a hook.

import { invoke } from '@tauri-apps/api/core'
import { basenameOf } from '@/lib/coworkPreview'

/** Which set of changes to inspect. Mirrors the Rust `DiffScope`. */
export type GitScope = 'working' | 'staged' | 'all'

/** One file's change kind, mirroring the Rust `status_word` values. */
export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type_changed'
  | 'untracked'
  | 'unmerged'

/** One changed file. `path` is repo-relative and, for renames, the new path. */
export type GitFileEntry = {
  path: string
  origPath: string | null
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
  additions: number
  deletions: number
  binary: boolean
}

/** A whole working-tree snapshot for one scope. */
export type GitStatus = {
  branch: string | null
  repoRoot: string
  files: GitFileEntry[]
  additions: number
  deletions: number
}

/** A single file's lazily-loaded unified diff. */
export type GitFileDiff = {
  diff: string
  binary: boolean
  truncated: boolean
}

/**
 * Working-tree status for the attached project under `scope`. Resolves to
 * `null` when the folder is not inside a git repository (the backend returns
 * `None` there rather than erroring), so the panel can say "not a git repo"
 * instead of showing a failure.
 */
export async function loadGitStatus(
  project: string,
  scope: GitScope
): Promise<GitStatus | null> {
  return (await invoke('agent_git_status', {
    project,
    scope,
  })) as GitStatus | null
}

/** The unified diff for one file, loaded on demand when its row is expanded. */
export async function loadGitFileDiff(
  project: string,
  path: string,
  scope: GitScope
): Promise<GitFileDiff> {
  return (await invoke('agent_git_file_diff', {
    project,
    path,
    scope,
  })) as GitFileDiff
}

/** A file's bytes at HEAD, or null when nothing is committed to compare with. */
export async function loadGitHeadFile(
  project: string,
  path: string
): Promise<string | null> {
  return (await invoke('agent_git_head_file', { project, path })) as
    | string
    | null
}

/** Raw `git blame --porcelain`, and `origin`'s GitHub URL when it has one. */
export type GitBlameResult = { porcelain: string | null; webUrl: string | null }

export async function loadGitBlame(
  project: string,
  path: string
): Promise<GitBlameResult> {
  return (await invoke('agent_git_blame', { project, path })) as GitBlameResult
}

type CommitPr = { number: number; url: string } | null
const prCache = new Map<string, Promise<CommitPr>>()

/**
 * The pull request a commit belongs to, via `gh`; null when `gh` is missing
 * or finds nothing. Cached per repository and commit for the app's life, so
 * hovering the same line again never re-runs `gh`.
 */
export function loadCommitPr(project: string, sha: string): Promise<CommitPr> {
  const key = `${project}\u0000${sha}`
  let hit = prCache.get(key)
  if (!hit) {
    hit = (
      invoke('agent_git_pr_for_commit', { project, sha }) as Promise<CommitPr>
    ).catch(() => null)
    prCache.set(key, hit)
  }
  return hit
}

/** Repository folder name for the review header, or null when unknown. */
export function repoName(status: GitStatus | null): string | null {
  if (!status?.repoRoot) return null
  return basenameOf(status.repoRoot) || status.repoRoot
}

/** Short single-letter badge for a change status, as in the reference UI. */
export function statusBadge(status: GitFileStatus): string {
  switch (status) {
    case 'modified':
      return 'M'
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    case 'type_changed':
      return 'T'
    case 'untracked':
      return 'U'
    case 'unmerged':
      return '!'
  }
}
