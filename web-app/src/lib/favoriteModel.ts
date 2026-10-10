/**
 * A starred model. `provider` names the provider it was starred under: two
 * providers can list the same model id, and starring one must not star the
 * other. Entries saved before that was recorded have none.
 */
export type FavoriteModel = Model & { provider?: string }

/**
 * Whether `fav` is the favorite for `modelId` under `provider`. An entry saved
 * without a provider matches any provider until it is settled by
 * `assignLegacyProviders`; omitting `provider` matches any entry with that id.
 */
export const isFavoriteEntry = (
  fav: FavoriteModel,
  modelId: string,
  provider?: string
): boolean =>
  fav.id === modelId &&
  (provider === undefined ||
    fav.provider === undefined ||
    fav.provider === provider)
