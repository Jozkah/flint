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

export async function applySandboxFile(input: {
  session: string
  path: string
  project: string
  overwrite: boolean
}): Promise<SandboxApplyOutcome> {
  return await invoke<SandboxApplyOutcome>('agent_sandbox_apply_file', input)
}
