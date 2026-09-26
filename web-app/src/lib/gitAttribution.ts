import { invoke } from '@tauri-apps/api/core'
import { isPlainObject, parseToolInput } from '@/lib/toolInputSummary'

/**
 * Flint's attribution on the agent's commits and pull requests: a
 * `Co-Authored-By` trailer naming the run's model, and a "Generated with
 * Flint" line at the end of a pull request body.
 *
 * The rewriting itself lives in Rust (`tools/git_attribution.rs`), shared with
 * the desktop agent loop and the CLI, so the trailer and its address exist in
 * one place. The renderer asks for a call to be rewritten before it is put to
 * the user, so the approval prompt shows exactly what will be committed or
 * posted.
 */
export type AttributionSettings = {
  /** Add Flint as co-author on commits. */
  commits: boolean
  /** Add "Generated with Flint" to pull requests. */
  pullRequests: boolean
}

export const DEFAULT_ATTRIBUTION_SETTINGS: AttributionSettings = {
  commits: true,
  pullRequests: true,
}

const inTauri = (): boolean =>
  typeof window !== 'undefined' &&
  !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__

export async function getAttributionSettings(): Promise<AttributionSettings> {
  if (!inTauri()) return DEFAULT_ATTRIBUTION_SETTINGS
  return invoke<AttributionSettings>('get_attribution_settings')
}

export async function setAttributionSettings(
  settings: AttributionSettings
): Promise<AttributionSettings> {
  return invoke<AttributionSettings>('set_attribution_settings', { settings })
}

/**
 * A `git` tool call's input with the attribution the user's settings ask for.
 * Anything that is not a commit or a pull request create/edit comes back
 * unchanged. A failure leaves the call as the model wrote it: attribution is
 * never a reason to refuse the work.
 */
export async function attributeGitInput(
  input: unknown,
  model: string | undefined,
  base?: string | null,
  /**
   * With no `base`, the folder the git tool itself defaults to: this Chat
   * thread's workspace, or (`session`) this Cowork session's sandbox.
   */
  owner?: { id: string; session?: boolean }
): Promise<unknown> {
  const parsed = parseToolInput(input)
  if (!inTauri() || !isPlainObject(parsed)) return input
  try {
    return await invoke<unknown>('attribute_git_call', {
      input: parsed,
      model: model ?? '',
      base: base ?? null,
      threadId: owner?.id ?? null,
      session: owner?.session ?? null,
    })
  } catch {
    return input
  }
}
