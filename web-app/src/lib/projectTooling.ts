/**
 * The attached project's frameworks, build systems and test runners, as the
 * backend detected them. AH-068 / AH-069 / AH-070.
 *
 * Detection lives in `core::agent::tooling` alone. This is only the call, so
 * the desktop cannot describe a project differently from the CLI: the prompt
 * block it hands the model is the backend's own text, not a re-rendering.
 */
import { invoke } from '@tauri-apps/api/core'
import type { ToolingReadiness } from '@/lib/coworkReadiness'

type Report = Extract<ToolingReadiness, { state: 'ready' }> extends infer R
  ? Omit<R, 'state'> & { prompt: string | null }
  : never

/** The readiness state, and the prompt block (null when there is nothing). */
export type LoadedTooling = {
  readiness: ToolingReadiness
  prompt: string | null
}

/**
 * Never throws: a detection that cannot run is a typed failed state, and the
 * folder stays usable without the facts.
 */
export async function loadProjectTooling(
  folder: string,
  call: (cmd: string, args: { folder: string }) => Promise<unknown> = invoke
): Promise<LoadedTooling> {
  try {
    const report = (await call('project_tooling', { folder })) as Report
    return {
      readiness: {
        state: 'ready',
        facts: report.facts ?? [],
        conflicts: report.conflicts ?? [],
        skipped: report.skipped ?? [],
        truncated: report.truncated ?? null,
      },
      prompt: report.prompt ?? null,
    }
  } catch (e) {
    const typed =
      e && typeof e === 'object' && 'kind' in e && 'message' in e
        ? (e as { kind: string; message: string })
        : null
    return {
      readiness: {
        state: 'failed',
        error: typed ?? {
          kind: 'unavailable',
          message: e instanceof Error ? e.message : String(e),
        },
      },
      prompt: null,
    }
  }
}
