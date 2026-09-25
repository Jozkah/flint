/**
 * The order models are listed in.
 *
 * Lists are sorted by the name the user sees, not by the id underneath, so a
 * renamed model sits where its new name says it should. Sorting is pure and
 * store-free; the chosen option and the usage history live in `useModelOrder`.
 */

import { getModelDisplayName, getProviderTitle } from '@/lib/utils'

export const MODEL_SORT_OPTIONS = [
  'name-asc',
  'name-desc',
  'recent',
  'provider',
] as const

export type ModelSortOption = (typeof MODEL_SORT_OPTIONS)[number]

/**
 * A section per provider, local ones first, until the user says otherwise:
 * the list then also says where each model runs.
 */
export const DEFAULT_MODEL_SORT: ModelSortOption = 'provider'

export function isModelSortOption(value: unknown): value is ModelSortOption {
  return MODEL_SORT_OPTIONS.includes(value as ModelSortOption)
}

/** The shape every model list shares: a model and the provider serving it. */
export type SortableModel = {
  model: Model
  provider: { provider: string }
}

/** How a model is addressed in the usage history. */
export function modelUsageKey(providerName: string, modelId: string): string {
  return `${providerName}:${modelId}`
}

/** When a model was last picked, or 0 for one that never has been. */
export function lastUsedAt(
  lastUsed: Readonly<Record<string, number>> | undefined,
  item: SortableModel
): number {
  if (!lastUsed) return 0
  return lastUsed[modelUsageKey(item.provider.provider, item.model.id)] ?? 0
}

/**
 * Compare display names the way a reader would: case-insensitively, and with
 * embedded numbers read as numbers so "llama-9b" precedes "llama-70b".
 */
function compareNames(a: SortableModel, b: SortableModel): number {
  const byName = getModelDisplayName(a.model).localeCompare(
    getModelDisplayName(b.model),
    undefined,
    { sensitivity: 'base', numeric: true }
  )
  if (byName !== 0) return byName
  // Two models may legitimately share a name across providers; fall through to
  // the identifiers so the order never depends on input order.
  const byId = a.model.id.localeCompare(b.model.id)
  if (byId !== 0) return byId
  return a.provider.provider.localeCompare(b.provider.provider)
}

/**
 * A list ordered by the chosen option.
 *
 * Returns a new array; the input is left alone because callers hold it in
 * memoized state.
 */
export function sortModels<T extends SortableModel>(
  items: readonly T[],
  sort: ModelSortOption,
  lastUsed?: Readonly<Record<string, number>>
): T[] {
  const sorted = [...items]

  switch (sort) {
    case 'name-desc':
      return sorted.sort((a, b) => -compareNames(a, b))

    case 'recent':
      return sorted.sort((a, b) => {
        const byRecency = lastUsedAt(lastUsed, b) - lastUsedAt(lastUsed, a)
        // Models never used have nothing to rank them by, so they keep their
        // alphabetical order at the end rather than an arbitrary one.
        return byRecency !== 0 ? byRecency : compareNames(a, b)
      })

    case 'provider':
      return sorted.sort((a, b) => {
        const byProvider = getProviderTitle(a.provider.provider).localeCompare(
          getProviderTitle(b.provider.provider),
          undefined,
          { sensitivity: 'base' }
        )
        return byProvider !== 0 ? byProvider : compareNames(a, b)
      })

    case 'name-asc':
    default:
      return sorted.sort(compareNames)
  }
}
