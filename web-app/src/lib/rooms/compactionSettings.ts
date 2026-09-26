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
  policy: Pick<CompactionPolicy, 'auto'>
): RoomCompactionSettings {
  const settings = resolveModel(ref, lookup).model?.settings
  const auto = settingValue(settings, 'auto_compact')
  return {
    enabled: resolveAutoCompact(
      auto === undefined ? undefined : { auto_compact: auto },
      policy.auto
    ),
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
