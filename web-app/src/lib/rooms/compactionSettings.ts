import { resolveAutoCompact } from '@/lib/compaction'
import { usableContextValue } from '@/lib/modelCapabilities'
import {
  DEFAULT_COMPACTION_POLICY,
  getCompactionPolicy,
  type CompactionPolicy,
} from '@/lib/compactionPolicy'
import { resolveModel, type ProviderLookup } from './availability'
import type { RoomModelRef } from './types'

export type RoomCompactionSettings = {
  enabled: boolean
  threshold?: number
  window?: number | null
  /** The most a summary may run to, in tokens (the policy's `summaryMaxTokens`). */
  summaryMaxTokens?: number
}

/** A model setting's value, whichever shape it is stored in. */
function settingValue(settings: unknown, key: string): unknown {
  const entry = (settings as Record<string, unknown> | undefined)?.[key] as
    | { controller_props?: { value?: unknown } }
    | unknown
  if (entry && typeof entry === 'object' && 'controller_props' in entry) {
    return (entry as { controller_props?: { value?: unknown } }).controller_props?.value
  }
  return entry
}

/**
 * The compaction settings for one participant's model: its own Auto Compact
 * and Max Context Tokens when that model sets them, otherwise the shared
 * policy (read once when the room starts) and the model's known window.
 */
export function roomCompactionSettingsFor(
  ref: RoomModelRef,
  lookup: ProviderLookup,
  policy: Pick<CompactionPolicy, 'auto'> &
    Partial<Pick<CompactionPolicy, 'strategy' | 'summaryMaxTokens'>>
): RoomCompactionSettings {
  const settings = resolveModel(ref, lookup).model?.settings
  const auto = settingValue(settings, 'auto_compact')
  return {
    // The `trim` strategy means no summary is written, whatever Auto Compact
    // says: older history is left out, as Chat does under the same policy.
    enabled:
      policy.strategy !== 'trim' &&
      resolveAutoCompact(
        auto === undefined ? undefined : { auto_compact: auto },
        policy.auto
      ),
    ...(policy.summaryMaxTokens != null && policy.summaryMaxTokens > 0
      ? { summaryMaxTokens: policy.summaryMaxTokens }
      : {}),
    window: usableContextValue(settingValue(settings, 'max_context_tokens')) ?? null,
  }
}

/** The shared policy for a room run; defaults when it cannot be read. */
export async function loadRoomCompactionPolicy(): Promise<CompactionPolicy> {
  try {
    return await getCompactionPolicy()
  } catch {
    return DEFAULT_COMPACTION_POLICY
  }
}
