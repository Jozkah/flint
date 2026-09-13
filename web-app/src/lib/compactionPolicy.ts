import { invoke } from '@tauri-apps/api/core'

/**
 * The one compaction policy (AH-076), as the backend resolves it: defaults,
 * then the user's `<data folder>/compaction.json`, then the project's. The chat
 * transport, the desktop agent loop and the CLI all read the same file, so a
 * conversation compacts at the same point whichever surface it is open in.
 */
export type CompactionStrategy = 'summarize' | 'trim'
export type CompactionOrigin = 'default' | 'user' | 'project'

export type CompactionPolicy = {
  auto: boolean
  reserveTokens: number
  keepRecent: number
  strategy: CompactionStrategy
  summaryMaxTokens: number
  origins: {
    auto: CompactionOrigin
    reserveTokens: CompactionOrigin
    keepRecent: CompactionOrigin
    strategy: CompactionOrigin
    summaryMaxTokens: CompactionOrigin
  }
}

/** A user-scope edit: only the fields being set. */
export type CompactionLayer = Partial<
  Pick<CompactionPolicy, 'auto' | 'reserveTokens' | 'keepRecent' | 'strategy' | 'summaryMaxTokens'>
>

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  auto: true,
  reserveTokens: 16384,
  keepRecent: 8,
  strategy: 'summarize',
  summaryMaxTokens: 512,
  origins: {
    auto: 'default',
    reserveTokens: 'default',
    keepRecent: 'default',
    strategy: 'default',
    summaryMaxTokens: 'default',
  },
}

const inTauri = (): boolean =>
  typeof window !== 'undefined' &&
  !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__

/**
 * Read the effective policy. Outside the desktop there is no backend to ask,
 * and the defaults are what every surface would use there anyway.
 *
 * A file the backend refuses (a value out of range, an unknown field) is
 * thrown, not replaced by defaults: compacting at a point nobody chose is the
 * failure this exists to prevent.
 */
export async function getCompactionPolicy(project?: string | null): Promise<CompactionPolicy> {
  if (!inTauri()) return DEFAULT_COMPACTION_POLICY
  return invoke<CompactionPolicy>('get_compaction_policy', { project: project ?? null })
}

/** Save the user's layer. The backend validates before writing. */
export async function setCompactionPolicy(layer: CompactionLayer): Promise<CompactionPolicy> {
  return invoke<CompactionPolicy>('set_compaction_policy', { layer })
}

/**
 * The reserve kept free in a window this size: never more than a quarter of
 * it, the same rule the backend applies (`Policy::effective_reserve`), so a
 * small local model keeps its context.
 */
export function effectiveReserve(
  maxContextTokens: number,
  policy: Pick<CompactionPolicy, 'reserveTokens'>
): number {
  return Math.min(policy.reserveTokens, Math.floor(maxContextTokens / 4))
}

/** Output headroom for a request: the model's cap or the reserve, whichever is larger. */
export function outputHeadroom(
  maxContextTokens: number,
  maxOutputTokens: number,
  policy: Pick<CompactionPolicy, 'reserveTokens'>
): number {
  return Math.max(maxOutputTokens, effectiveReserve(maxContextTokens, policy))
}
