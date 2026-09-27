/**
 * Bring one file a Review only session wrote into its sandbox across to the
 * attached folder (backend: `agent_sandbox_apply_file`).
 *
 * The backend resolves the sandbox from the session id and checks both ends on
 * disk. An existing file is never replaced on the first call: it answers
 * `exists`, and only a second call with `overwrite` -- made after the user
 * confirmed -- replaces it.
 */
import { invoke } from '@tauri-apps/api/core'
import { relativeToRoot } from '@/lib/coworkCode'
import { basenameOf } from '@/lib/coworkPreview'

export type SandboxApplyOutcome = 'created' | 'replaced' | 'exists'

/**
 * The path relative to the sandbox, or null when it is not a sandbox file.
 * Diff rows can carry either an absolute path under the sandbox or one that is
 * already relative to it.
 */
export function sandboxRelativePath(
  sandboxRoot: string | null,
  path: string
): string | null {
  const relative = relativeToRoot(sandboxRoot, path)
  if (!relative) return null
  if (relative !== path) return relative
  // Unchanged: relative already, unless it is absolute somewhere else.
  const absolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path)
  return absolute ? null : path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Where one sandbox file would be copied, as shown to the user first. */
export type SandboxApplyPlan = {
  /** The file's path inside the sandbox. */
  source: string
  /** The attached folder it goes into. */
  folder: string
  /** Its path inside `folder`. */
  destination: string
  /**
   * The sandbox path began with the folder's own name (a run that mirrored the
   * project into the sandbox), so that segment was dropped. Copying to the
   * same relative path would have made `KewScraper/KewScraper/go.mod`; this
   * destination is a guess the user confirms before anything is copied.
   */
  remapped: boolean
}

/**
 * Where `path` would land if applied, or null when it cannot be: not a
 * sandbox file (an edit Flint made to a real file in place has nothing to
 * copy), or no folder to copy into.
 *
 * Takes every attached folder, so a session with several can map a mirrored
 * path to the folder it names; the first folder is the default.
 */
export function planSandboxApply(
  sandboxRoot: string | null,
  folders: readonly string[],
  path: string
): SandboxApplyPlan | null {
  const source = sandboxRelativePath(sandboxRoot, path)
  if (!source || folders.length === 0) return null
  if (isFlintInternalPath(sandboxRoot, path)) return null
  const [first, ...rest] = source.split('/')
  if (rest.length > 0) {
    const named = folders.find(
      (folder) => basenameOf(folder).toLowerCase() === first.toLowerCase()
    )
    if (named) {
      return { source, folder: named, destination: rest.join('/'), remapped: true }
    }
  }
  return { source, folder: folders[0], destination: source, remapped: false }
}

/** Folders in a sandbox that hold Flint's own settings, never run output. */
const INTERNAL_SANDBOX_DIRS = new Set(['.jan', '.flint'])

/**
 * Whether a written path is Flint's own bookkeeping rather than something the
 * run produced: the sandbox's `.jan/` (agent settings, hooks, memory), or any
 * other place in Flint's data folder -- memory, logs, other sessions. Every
 * successful write or edit is recorded as a change wherever it landed, so
 * without this those files were listed as session output with "Apply to
 * folder" beside them.
 *
 * The data folder is found from the sandbox itself
 * (`<data>/agent-workspace/sessions/<id>`). Flint-owned worktrees
 * (`<data>/agent-workspace/worktrees/...`) hold real work and stay listed.
 */
export function isFlintInternalPath(
  sandboxRoot: string | null,
  path: string
): boolean {
  if (!sandboxRoot) return false
  const inSandbox = sandboxRelativePath(sandboxRoot, path)
  if (inSandbox !== null) {
    return INTERNAL_SANDBOX_DIRS.has(inSandbox.split('/')[0].toLowerCase())
  }
  const segments = sandboxRoot.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  if (segments.length < 4 || segments[segments.length - 2] !== 'sessions') {
    return false
  }
  const store = segments.slice(0, -2).join('/')
  const dataFolder = segments.slice(0, -3).join('/')
  const inside = (root: string) => relativeToRoot(root, path) !== path
  return inside(dataFolder) && !inside(`${store}/worktrees`)
}

/**
 * The sandbox file a Review only run wrote for `projectPath` (relative to
 * `folder`), found the way Apply to folder maps sandbox files to the folder,
 * so the two always agree on which file is whose copy.
 */
export function sandboxCopyOfProjectFile(
  paths: readonly string[],
  planFor: (path: string) => SandboxApplyPlan | null,
  folder: string | null,
  projectPath: string
): { path: string; plan: SandboxApplyPlan } | null {
  if (!folder) return null
  const norm = (p: string) =>
    p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()
  const want = norm(projectPath)
  for (const path of paths) {
    const plan = planFor(path)
    if (plan && norm(plan.folder) === norm(folder) && norm(plan.destination) === want) {
      return { path, plan }
    }
  }
  return null
}

export async function applySandboxFile(input: {
  session: string
  path: string
  project: string
  /** Inside `project`; the sandbox path when absent. */
  destination?: string
  overwrite: boolean
}): Promise<SandboxApplyOutcome> {
  return await invoke<SandboxApplyOutcome>('agent_sandbox_apply_file', input)
}
