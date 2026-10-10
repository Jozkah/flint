import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import { isFavoriteEntry, type FavoriteModel } from '@/lib/favoriteModel'

export type { FavoriteModel }

interface FavoriteModelState {
  favoriteModels: FavoriteModel[]
  addFavorite: (model: Model, provider?: string) => void
  removeFavorite: (modelId: string, provider?: string) => void
  isFavorite: (modelId: string, provider?: string) => boolean
  toggleFavorite: (model: Model, provider?: string) => void
  /**
   * Give each entry saved without a provider to every provider that lists its
   * model, which is what the user saw before: nothing disappears, and each
   * entry can then be un-starred on its own. An entry no provider lists is
   * left as it was.
   */
  assignLegacyProviders: (
    providers: { provider: string; models: { id: string }[] }[]
  ) => void
}

export const useFavoriteModel = create<FavoriteModelState>()(
  persist(
    (set, get) => ({
      favoriteModels: [],

      addFavorite: (model: Model, provider?: string) => {
        set((state) => {
          const owner = provider ?? (model as FavoriteModel).provider
          if (
            !state.favoriteModels.some(
              (fav) => fav.id === model.id && fav.provider === owner
            )
          ) {
            return {
              favoriteModels: [
                ...state.favoriteModels,
                { ...model, provider: owner },
              ],
            }
          }
          return state
        })
      },

      removeFavorite: (modelId: string, provider?: string) => {
        set((state) => ({
          favoriteModels: state.favoriteModels.filter(
            (fav) => !isFavoriteEntry(fav, modelId, provider)
          ),
        }))
      },

      isFavorite: (modelId: string, provider?: string) => {
        return get().favoriteModels.some((fav) =>
          isFavoriteEntry(fav, modelId, provider)
        )
      },

      toggleFavorite: (model: Model, provider?: string) => {
        const { isFavorite, addFavorite, removeFavorite } = get()
        const owner = provider ?? (model as FavoriteModel).provider
        if (isFavorite(model.id, owner)) {
          removeFavorite(model.id, owner)
        } else {
          addFavorite(model, owner)
        }
      },

      assignLegacyProviders: (providers) => {
        set((state) => {
          if (state.favoriteModels.every((fav) => fav.provider !== undefined)) {
            return state
          }
          const next: FavoriteModel[] = []
          for (const fav of state.favoriteModels) {
            if (fav.provider !== undefined) {
              next.push(fav)
              continue
            }
            const owners = providers.filter((p) =>
              p.models.some((m) => m.id === fav.id)
            )
            if (owners.length === 0) {
              next.push(fav)
              continue
            }
            for (const owner of owners) {
              if (
                !next.some((n) => n.id === fav.id && n.provider === owner.provider)
              ) {
                next.push({ ...fav, provider: owner.provider })
              }
            }
          }
          return { favoriteModels: next }
        })
      },
    }),
    {
      name: localStorageKey.favoriteModels,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
    }
  )
)
