import { checkModel, defaultProviderLookup, type ProviderLookup } from '@/lib/rooms/availability'

export type ModelRef = { provider: string; id: string }

/** A model reference as a map key. */
export const modelKey = (ref: ModelRef): string => `${ref.provider}\u0000${ref.id}`

/**
 * The models among `refs` that cannot be used now: the provider is gone or not
 * ready, or the model is no longer in its list. Each appears once.
 */
export function unavailableModels(
  refs: readonly (ModelRef | null | undefined)[],
  lookup: ProviderLookup = defaultProviderLookup
): ModelRef[] {
  const seen = new Set<string>()
  const out: ModelRef[] = []
  for (const ref of refs) {
    if (!ref?.id) continue
    const key = modelKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    if (checkModel(ref, lookup)) out.push(ref)
  }
  return out
}
