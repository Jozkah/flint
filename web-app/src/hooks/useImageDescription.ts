import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { backendStorage } from '@/lib/backendStorage'

/**
 * How images reach a model that cannot see them, and whether they are kept
 * searchable.
 *
 * - `enabled`: a model without vision gets a written description of each
 *   attached image (made by a model that can see it) in place of the image.
 *   Off, such a model gets nothing for the image, as before.
 * - `model`: which model writes the descriptions. Absent means the first remote
 *   model that can see; a local one is used only when the user picks it, since
 *   using it can mean loading a large model nobody asked for.
 * - `embed`: also store each image's description with the conversation's
 *   documents, so it can be searched later. Off by default: it sends every
 *   attached image to the description model whether or not the chat model
 *   could see it.
 */
type ImageDescriptionState = {
  enabled: boolean
  model: { provider: string; id: string } | null
  embed: boolean
  setEnabled: (enabled: boolean) => void
  setModel: (model: { provider: string; id: string } | null) => void
  setEmbed: (embed: boolean) => void
}

export const IMAGE_DESCRIPTION_KEY = 'flint-image-description'

export const useImageDescription = create<ImageDescriptionState>()(
  persist(
    (set) => ({
      enabled: true,
      model: null,
      embed: false,
      setEnabled: (enabled) => set({ enabled }),
      setModel: (model) => set({ model }),
      setEmbed: (embed) => set({ embed }),
    }),
    {
      name: IMAGE_DESCRIPTION_KEY,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (s) =>
        ({ enabled: s.enabled, model: s.model, embed: s.embed }) as unknown as ImageDescriptionState,
    }
  )
)
