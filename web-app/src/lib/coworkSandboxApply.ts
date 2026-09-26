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
