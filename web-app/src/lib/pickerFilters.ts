/**
 * The filters of the shared picker (`PickerDropdown`): which rows stay, and in
 * what order. Pure and store-free; the picker keeps the chosen state for the
 * session, and consumers only describe their rows (`PickerMeta`).
 */

export const PICKER_CAPABILITIES = ['vision', 'tools', 'reasoning', 'embeddings'] as const
export type PickerCapability = (typeof PICKER_CAPABILITIES)[number]

export type PickerSource = 'all' | 'local' | 'cloud'
export type PickerSort = 'default' | 'name' | 'recent' | 'size'

/** What a consumer may tell the picker about a row. All of it is optional. */
export type PickerMeta = {
  kind?: 'local' | 'cloud'
  capabilities?: string[]
  /** The model is in memory right now. */
  loaded?: boolean
  sizeBytes?: number
  /** Epoch millis of the last time it was picked. */
  lastUsedAt?: number
}

export type PickerFilterState = {
  source: PickerSource
  capabilities: PickerCapability[]
  loadedOnly: boolean
  sort: PickerSort
}

export const EMPTY_PICKER_FILTERS: PickerFilterState = {
  source: 'all',
  capabilities: [],
  loadedOnly: false,
  sort: 'default',
}

type Row = PickerMeta & { label: string }
type Group<T extends Row> = { label?: string; items: T[] }

/** Which controls the list can support: a control with nothing to act on is not offered. */
export type PickerFacets = {
  source: boolean
  capabilities: PickerCapability[]
  loaded: boolean
  sorts: PickerSort[]
}

export function pickerFacets<T extends Row>(groups: Group<T>[]): PickerFacets {
  const items = groups.flatMap((g) => g.items)
  const kinds = new Set(items.map((i) => i.kind).filter(Boolean))
  const capabilities = PICKER_CAPABILITIES.filter((c) => items.some((i) => i.capabilities?.includes(c)))
  const sorts: PickerSort[] = []
  if (items.length > 1) sorts.push('name')
  if (items.some((i) => i.lastUsedAt)) sorts.push('recent')
  if (items.some((i) => i.sizeBytes)) sorts.push('size')
  return {
    source: kinds.size > 1,
    capabilities,
    loaded: items.some((i) => i.loaded !== undefined),
    sorts,
  }
}

/** Does the picker have any filter at all to show? */
export const hasFacets = (f: PickerFacets) =>
  f.source || f.capabilities.length > 0 || f.loaded || f.sorts.length > 0

/** How many filters are narrowing the list (sort is an order, not a narrowing). */
export function activeFilterCount(s: PickerFilterState): number {
  return (s.source !== 'all' ? 1 : 0) + s.capabilities.length + (s.loadedOnly ? 1 : 0)
}

/** Narrowing or reordering: either one makes "clear" worth offering. */
export const isFiltered = (s: PickerFilterState) =>
  activeFilterCount(s) > 0 || s.sort !== 'default'

const byName = (a: Row, b: Row) =>
  a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true })

const SORTERS: Record<Exclude<PickerSort, 'default'>, (a: Row, b: Row) => number> = {
  name: byName,
  recent: (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || byName(a, b),
  size: (a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || byName(a, b),
}

/** The groups with only the rows the filters keep, each group in the chosen order. */
export function applyPickerFilters<T extends Row>(
  groups: Group<T>[],
  s: PickerFilterState
): Group<T>[] {
  const keep = (i: T) =>
    (s.source === 'all' || i.kind === s.source) &&
    s.capabilities.every((c) => i.capabilities?.includes(c)) &&
    (!s.loadedOnly || i.loaded === true)
  return groups
    .map((g) => {
      const items = g.items.filter(keep)
      return { ...g, items: s.sort === 'default' ? items : [...items].sort(SORTERS[s.sort]) }
    })
    .filter((g) => g.items.length > 0)
}
