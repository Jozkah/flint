import { localStorageKey } from '@/constants/localStorage'
import { type ModelSortOption } from '@/lib/modelSort'

/** A section heading in the picker: Favorites, local, cloud. */
export const SECTION_HEADING =
  'px-2 pt-2.5 pb-1 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium tracking-wide text-subtle-foreground uppercase'

/** The menu entry for each order. */
export const SORT_LABEL_KEYS: Record<ModelSortOption, string> = {
  'name-asc': 'common:sortNameAsc',
  'name-desc': 'common:sortNameDesc',
  recent: 'common:sortRecent',
  provider: 'common:sortProvider',
}

// Helper functions for localStorage
export const setLastUsedModel = (provider: string, model: string) => {
  try {
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider, model })
    )
  } catch (error) {
    console.debug('Failed to set last used model in localStorage:', error)
  }
}
