import type { ResolvedCodePath } from '@/lib/codePathResolve'
import { isNotFoundError } from '@/lib/fileErrors'
import { errorText } from '@/lib/errorText'

/** The two bounded reads a path can be probed with. */
export type ExistsProbe = {
  /** Reads (and rejects) like `projectReadFile`. */
  project: (rel: string) => Promise<unknown>
  /** True when the sandbox file is absent (a 404 from the asset read). */
  sandboxMissing: (rel: string) => Promise<boolean>
}

/**
 * Whether the file a resolved path names exists. Only a definite "not found"
 * answers false; anything else (denied, too large, binary, a failed probe)
 * counts as present so the Code panel can say what is really wrong.
 */
export async function codePathExists(
  resolved: ResolvedCodePath,
  probe: ExistsProbe
): Promise<boolean> {
  try {
    if (resolved.kind === 'project') {
      await probe.project(resolved.rel)
      return true
    }
    if (resolved.kind === 'sandbox') return !(await probe.sandboxMissing(resolved.rel))
    return true
  } catch (e) {
    return !isNotFoundError(errorText(e))
  }
}
