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
  /** Compact at this % of the context window; 0 keeps the built-in trigger. */
  compactAtPercent: number
  origins: {
    auto: CompactionOrigin
    reserveTokens: CompactionOrigin
    keepRecent: CompactionOrigin
    strategy: CompactionOrigin
    summaryMaxTokens: CompactionOrigin
    compactAtPercent: CompactionOrigin
  }
}

/** A user-scope edit: only the fields being set. */
export type CompactionLayer = Partial<
  Pick<CompactionPolicy, 'auto' | 'reserveTokens' | 'keepRecent' | 'strategy' | 'summaryMaxTokens' | 'compactAtPercent'
  >
>

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  auto: true,
  reserveTokens: 16384,
  keepRecent: 8,
  strategy: 'summarize',
  summaryMaxTokens: 512,
  compactAtPercent: 0,
  origins: {
    auto: 'default',
    reserveTokens: 'default',
    keepRecent: 'default',
    strategy: 'default',
    summaryMaxTokens: 'default',
    compactAtPercent: 'default',
  },
}

/** Range a chosen compaction point must fall in (`compaction_policy.rs`). */
export const MIN_COMPACT_AT_PERCENT = 50
export const MAX_COMPACT_AT_PERCENT = 95

/** A chosen percentage forced into range; 0 (automatic) stays 0. */
export function clampCompactAtPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0
  return Math.min(MAX_COMPACT_AT_PERCENT, Math.max(MIN_COMPACT_AT_PERCENT, Math.round(percent)))
}

/**
 * Share of the window at which to compact: the user's percentage, or
 * `fallback` (the built-in trigger) when it is automatic.
 */
export function compactThresholdFor(
  policy: Partial<Pick<CompactionPolicy, 'compactAtPercent'>> | undefined,
  fallback: number
): number {
  const percent = clampCompactAtPercent(policy?.compactAtPercent ?? 0)
  return percent > 0 ? percent / 100 : fallback
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

/** Smallest autocompact buffer: a short reply and one more turn. */
export const MIN_RESERVE_TOKENS = 2048

/**
 * The autocompact buffer kept free in a window this size: a tenth of it, at
 * least 2K, never more than the policy's reserve (the 16K ceiling for big
 * windows) or a quarter of the window. The same rule the backend applies
 * (`scaled_reserve` in compaction_policy.rs), so a 50K local model keeps 5K
 * for the buffer instead of 12.5K and every surface agrees on the number.
 */
export function effectiveReserve(
  maxContextTokens: number,
  policy: Pick<CompactionPolicy, 'reserveTokens'> & {
    origins?: Pick<CompactionPolicy['origins'], 'reserveTokens'>
  }
): number {
  // A reserve the user or the project set is theirs: only the built-in
  // default is scaled down for a small window (`reserve_buffer` in Rust).
  const origin = policy.origins?.reserveTokens
  if (origin === 'user' || origin === 'project') {
    return Math.min(policy.reserveTokens, Math.floor(maxContextTokens / 4))
  }
  const scaled = Math.max(MIN_RESERVE_TOKENS, Math.floor(maxContextTokens / 10))
  return Math.min(policy.reserveTokens, scaled, Math.floor(maxContextTokens / 4))
}

/** Output headroom for a request: the model's cap or the reserve, whichever is larger. */
export function outputHeadroom(
  maxContextTokens: number,
  maxOutputTokens: number,
  policy: Pick<CompactionPolicy, 'reserveTokens'>
): number {
  // A hosted model's reply room is not the autocompact buffer: it keeps the
  // policy reserve, up to a quarter of the window, as before.
  const hostedReserve = Math.min(policy.reserveTokens, Math.floor(maxContextTokens / 4))
  return Math.max(maxOutputTokens, hostedReserve)
}

/** Above this, a local model's reply is given its own cap, not more. */
const LOCAL_REPLY_RESERVE = 2048
const LOCAL_REPLY_FRACTION = 0.1

/**
 * Room kept free for the reply. A local or self-hosted model (llama.cpp, a
 * server on this machine) keeps only what the user capped its reply at, or
 * min(2048, 10% of the window): an 8K reserve on a 32K model threw away a
 * quarter of the window. Hosted models keep `outputHeadroom` as before.
 */
export function replyReserve(
  maxContextTokens: number,
  maxOutputTokens: number | undefined,
  policy: Pick<CompactionPolicy, 'reserveTokens'>,
  local: boolean
): number {
  const userCap = maxOutputTokens && maxOutputTokens > 0 ? maxOutputTokens : undefined
  if (local) {
    return userCap ?? Math.min(LOCAL_REPLY_RESERVE, Math.floor(maxContextTokens * LOCAL_REPLY_FRACTION))
  }
  return outputHeadroom(maxContextTokens, userCap ?? 2048, policy)
}
