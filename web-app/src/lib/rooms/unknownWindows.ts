/**
 * Models in a room whose context window nobody knows. Without one the room
 * would silently budget for FALLBACK_CONTEXT_WINDOW; before it starts the user
 * is asked to set Max Context Tokens or to accept that default.
 */
import { useModelProvider } from '@/hooks/useModelProvider'
import { promptUnknownWindows } from '@/hooks/useUnknownWindowPrompt'
import { DEFAULT_COMPACTION_POLICY } from '@/lib/compactionPolicy'
import { usableContextValue } from '@/lib/modelCapabilities'
import { modelKey, type ModelRef } from '@/lib/modelReplace'
import {
  defaultProviderLookup,
  knownWindowFor,
  resolveModel,
  type ProviderLookup,
} from './availability'
import { roomCompactionSettingsFor } from './compactionSettings'
import type { Room } from './types'

export type UnknownWindowEntry = {
  /** The participant's id, or 'moderator'. */
  id: string
  name: string
  model: ModelRef
}

/** Whether a model has no window: no Max Context Tokens and no known capability. */
export function hasUnknownWindow(ref: ModelRef, lookup: ProviderLookup): boolean {
  // A model that cannot be found is the replace-model flow's business.
  if (!resolveModel(ref, lookup).model) return false
  const userSet = roomCompactionSettingsFor(ref, lookup, DEFAULT_COMPACTION_POLICY).window
  if (usableContextValue(userSet) != null) return false
  return knownWindowFor(ref, lookup) == null
}

/** Active participants (and the moderator, when on) whose model has an unknown window. */
export function participantsWithUnknownWindow(
  room: Room,
  lookup: ProviderLookup = defaultProviderLookup
): UnknownWindowEntry[] {
  const entries: UnknownWindowEntry[] = room.participants
    .filter((p) => !p.removed)
    .map((p) => ({ id: p.id, name: p.name, model: p.model }))
  if (room.moderator.enabled && room.moderator.model) {
    entries.push({ id: 'moderator', name: 'Moderator', model: room.moderator.model })
  }
  return entries.filter((e) => e.model?.id && hasUnknownWindow(e.model, lookup))
}

/** The distinct models behind those entries, in first-seen order. */
export function distinctModels(entries: readonly UnknownWindowEntry[]): ModelRef[] {
  const seen = new Set<string>()
  const out: ModelRef[] = []
  for (const e of entries) {
    const key = modelKey(e.model)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e.model)
  }
  return out
}

/** Models whose 8,192 fallback the user accepted; not asked about again this session. */
const accepted = new Set<string>()

export function rememberAcceptedWindows(models: readonly ModelRef[]) {
  for (const m of models) accepted.add(modelKey(m))
}

export function resetAcceptedWindows() {
  accepted.clear()
}

/**
 * Save a Max Context Tokens value on a model, the way the model settings
 * sheet does (the key is client-side only, so the provider store is the record).
 */
export function saveMaxContextTokens(ref: ModelRef, value: number) {
  const store = useModelProvider.getState()
  const provider = store.getProviderByName(ref.provider)
  if (!provider) return
  const models = provider.models.map((m) =>
    m.id === ref.id
      ? {
          ...m,
          settings: {
            ...m.settings,
            max_context_tokens: {
              ...(m.settings?.max_context_tokens ?? {}),
              controller_props: {
                ...(m.settings?.max_context_tokens?.controller_props ?? {}),
                value,
              },
            },
          },
        }
      : m
  )
  store.updateProvider(provider.provider, { models } as never)
}

/**
 * Before a room starts or resumes: if a model has an unknown window, ask the
 * user. Resolves false when they cancel (the room must not start), true when
 * every one is set or accepted, or none was unknown.
 */
export async function ensureKnownWindows(
  room: Room,
  lookup: ProviderLookup = defaultProviderLookup
): Promise<boolean> {
  const entries = participantsWithUnknownWindow(room, lookup).filter(
    (e) => !accepted.has(modelKey(e.model))
  )
  if (entries.length === 0) return true
  return promptUnknownWindows(room.title || 'This room', entries)
}
