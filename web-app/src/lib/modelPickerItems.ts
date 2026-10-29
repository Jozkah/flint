/**
 * The model picker's list, as pure functions of the provider store: which
 * models it offers, how a search narrows them, how they group by provider,
 * and what each row needs to tell two look-alike models apart.
 */
import { getProviderTitle, getModelDisplayName, isLocalProvider } from '@/lib/utils'
import { disambiguateModels, type Disambiguation } from '@/lib/modelDisplayName'
import { contextLengthOf } from '@/lib/engineModels'
import { classifyModelLocation } from '@/lib/modelLocation'
import { isFavoriteEntry, type FavoriteModel } from '@/lib/favoriteModel'
import { providerIsUnreachable } from '@/lib/modelAvailability'
import { offersModels } from '@/lib/providerOffers'
import { sortModels } from '@/lib/modelSort'
import { VOICE_MODEL_ID } from '@/lib/voice/voiceModel'

export interface SearchableModel {
  provider: ModelProvider
  model: Model
  searchStr: string
  value: string
}

/** `api.example.com:8080` from a base URL, or `''` when there is none. */
export function hostOf(baseUrl?: string): string {
  if (!baseUrl) return ''
  try {
    return new URL(baseUrl).host
  } catch {
    return ''
  }
}

/** Whether a provider's requests stay on this device or network. */
export const locationKind = (provider: ModelProvider): 'local' | 'remote' =>
  classifyModelLocation({
    baseUrl: provider.base_url,
    builtInEngine: Boolean(isLocalProvider(provider.provider)),
  }) === 'remote'
    ? 'remote'
    : 'local'

/** Is this model one of the user's favourites? */
export const isFavoriteItem = (
  favoriteModels: FavoriteModel[],
  item: SearchableModel
): boolean =>
  favoriteModels.some((fav) =>
    isFavoriteEntry(fav, item.model.id, item.provider.provider)
  )

/** Every chat model the picker offers, in provider order. */
export function buildSearchableItems(
  providers: ModelProvider[],
  {
    hideProvider,
    selectedProvider,
    selectedModelId,
  }: {
    hideProvider: (provider: ModelProvider) => boolean
    selectedProvider: string
    selectedModelId?: string
  }
): SearchableModel[] {
  const items: SearchableModel[] = []

  providers.forEach((provider) => {
    if (!provider.active) return
    const filteredOut = hideProvider(provider)

    provider.models.forEach((modelItem) => {
      // The filter never hides the model in use, so the list still shows it.
      if (
        filteredOut &&
        !(
          provider.provider === selectedProvider &&
          modelItem.id === selectedModelId
        )
      )
        return
      // Skip embedding models - they can't be used for chat
      if (modelItem.embedding) return
      // The dictation model transcribes speech; it is not for chatting.
      if (modelItem.id === VOICE_MODEL_ID) return

      // Only an unconfigured built-in template is hidden. See `offersModels`.
      if (!offersModels(provider)) return

      const capabilities = modelItem.capabilities || []
      const capabilitiesString = capabilities.join(' ')
      const providerTitle = getProviderTitle(provider.provider)

      // Create search string with model id, provider, and capabilities
      const searchStr =
        `${modelItem.id} ${providerTitle} ${provider.provider} ${capabilitiesString}`.toLowerCase()

      items.push({
        provider,
        model: modelItem,
        searchStr,
        value: `${provider.provider}:${modelItem.id}`,
      })
    })
  })

  return items
}

/**
 * Model ids offered by more than one provider (the same model behind two
 * remotes). Their rows must say which remote they belong to, everywhere.
 */
export function findAmbiguousModelIds(items: SearchableModel[]): Set<string> {
  const seen = new Map<string, number>()
  items.forEach((item) =>
    seen.set(item.model.id, (seen.get(item.model.id) ?? 0) + 1)
  )
  return new Set([...seen].filter(([, n]) => n > 1).map(([id]) => id))
}

/**
 * Models of one provider that read alike in a list (two quants, two
 * fine-tunes sharing a long prefix) get a short label from what differs.
 */
export function buildDisambiguation(
  items: SearchableModel[]
): Map<string, Disambiguation> {
  const merged = new Map<string, Disambiguation>()
  const byProvider = new Map<string, SearchableModel[]>()
  items.forEach((item) =>
    byProvider.set(item.provider.provider, [
      ...(byProvider.get(item.provider.provider) ?? []),
      item,
    ])
  )
  byProvider.forEach((group) => {
    disambiguateModels(
      group.map((item) => ({
        key: item.value,
        name: getModelDisplayName(item.model),
        fileName: item.model.id,
        contextLength: contextLengthOf(item.model),
      }))
    ).forEach((v, k) => merged.set(k, v))
  })
  return merged
}

/**
 * What to call a remote: its title, plus its host when another provider in
 * the list has the same title (two endpoints of one vendor, two local proxies).
 */
export function remoteLabelFor(
  items: SearchableModel[],
  p: ModelProvider
): string {
  const title = getProviderTitle(p.provider)
  const twins = items.filter(
    (i) =>
      i.provider.provider !== p.provider &&
      getProviderTitle(i.provider.provider) === title
  )
  if (twins.length === 0) return title
  const host = hostOf(p.base_url)
  return host ? `${title} · ${host}` : `${title} · ${p.provider}`
}

/**
 * The models a search keeps. Each word must appear verbatim (case-insensitive)
 * in the model's name or id, or in its remote: "gpt-4o work" is the copy of
 * gpt-4o behind the remote called "work". Order is the list order.
 */
export function filterBySearch(
  items: SearchableModel[],
  searchValue: string
): SearchableModel[] {
  if (!searchValue) return items
  const words = searchValue.toLowerCase().split(/\s+/).filter(Boolean)
  const modelText = (item: SearchableModel) =>
    `${getModelDisplayName(item.model)} ${item.model.id}`.toLowerCase()
  const remoteText = (item: SearchableModel) =>
    `${getProviderTitle(item.provider.provider)} ${item.provider.provider} ${hostOf(item.provider.base_url)}`.toLowerCase()
  return items.filter((item) => {
    const name = modelText(item)
    const remote = remoteText(item)
    return words.every((w) => name.includes(w) || remote.includes(w))
  })
}

/**
 * The provider sections. Without a search every active provider gets one,
 * even when empty (its header leads to its settings): local first, then
 * reachable before unreachable, configured before templates, then by name.
 * Favourites are pinned elsewhere and left out unless searching.
 */
export function buildPickerGroups({
  filteredItems,
  providers,
  searchValue,
  favoriteModels,
  unreachableOrigins,
  hideProvider,
  selectedProvider,
}: {
  filteredItems: SearchableModel[]
  providers: ModelProvider[]
  searchValue: string
  favoriteModels: FavoriteModel[]
  unreachableOrigins: Readonly<Record<string, unknown>>
  hideProvider: (provider: ModelProvider) => boolean
  selectedProvider: string
}): Record<string, SearchableModel[]> {
  const groups: Record<string, SearchableModel[]> = {}

  if (!searchValue) {
    const activeProviders = providers
      .filter(
        (p) => p.active && (!hideProvider(p) || p.provider === selectedProvider)
      )
      .sort((a, b) => {
        const aIsLocal = a.provider === 'llamacpp' || a.provider === 'mlx'
        const bIsLocal = b.provider === 'llamacpp' || b.provider === 'mlx'
        if (aIsLocal && !bIsLocal) return -1
        if (!aIsLocal && bIsLocal) return 1

        // A provider that did not answer its last request goes last.
        const aDown = providerIsUnreachable(a, unreachableOrigins)
        const bDown = providerIsUnreachable(b, unreachableOrigins)
        if (aDown !== bDown) return aDown ? 1 : -1

        // Configured providers sort above unconfigured templates. Same
        // predicate as the visibility gate, so the two cannot disagree about
        // what "configured" means.
        const aConfigured = offersModels(a)
        const bConfigured = offersModels(b)
        if (aConfigured && !bConfigured) return -1
        if (!aConfigured && bConfigured) return 1

        return a.provider.localeCompare(b.provider)
      })

    activeProviders.forEach((provider) => {
      groups[provider.provider] = []
    })
  }

  filteredItems.forEach((item) => {
    const providerKey = item.provider.provider
    if (!groups[providerKey]) {
      groups[providerKey] = []
    }
    // When not searching, favourites are not repeated in provider sections.
    if (!searchValue && isFavoriteItem(favoriteModels, item)) return
    groups[providerKey].push(item)
  })

  // Within a section the order is alphabetical by the name on screen, except
  // while searching, where the ranking is the quality of the match.
  if (!searchValue) {
    for (const key of Object.keys(groups)) {
      groups[key] = sortModels(groups[key], 'name-asc')
    }
  }

  return groups
}
