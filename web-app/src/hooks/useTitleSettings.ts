import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

/**
 * How automatic chat titles are made (janhq/jan#8345). Empty values mean the
 * default: the chat's own model, and the built-in prompt.
 */
type TitleSettings = {
  /** Provider of the model that writes titles; '' = the chat's own model. */
  titleModelProvider: string
  /** Model that writes titles; '' = the chat's own model. */
  titleModelId: string
  /** The instruction sent with the conversation; '' = the default prompt. */
  titlePrompt: string
  setTitleModel: (provider: string, modelId: string) => void
  setTitlePrompt: (prompt: string) => void
}

export const useTitleSettings = create<TitleSettings>()(
  persist(
    (set) => ({
      titleModelProvider: '',
      titleModelId: '',
      titlePrompt: '',
      setTitleModel: (titleModelProvider, titleModelId) =>
        set({ titleModelProvider, titleModelId }),
      setTitlePrompt: (titlePrompt) => set({ titlePrompt }),
    }),
    {
      name: localStorageKey.settingThreadTitle,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
    }
  )
)
