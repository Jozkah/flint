import { create } from 'zustand'
import type { GroupSurface } from './types'

type KeepRequest = {
  surface: GroupSurface
  groupName: string
  paths: string[]
  resolve: (keep: boolean) => void
}

type KeepPromptStore = {
  request: KeepRequest | null
  /** Ask whether an item leaving a group keeps the folders it inherited. */
  ask: (surface: GroupSurface, groupName: string, paths: string[]) => Promise<boolean>
  answer: (keep: boolean) => void
}

/**
 * The "keep the group's folders?" question, asked from a drag or a row menu
 * and answered in the dialog the surface's grouped tree renders.
 */
export const useKeepFoldersPrompt = create<KeepPromptStore>()((set, get) => ({
  request: null,
  ask: (surface, groupName, paths) =>
    new Promise<boolean>((resolve) => {
      // A question still open is answered "keep": nothing is detached unasked.
      get().request?.resolve(true)
      set({ request: { surface, groupName, paths, resolve } })
    }),
  answer: (keep) => {
    get().request?.resolve(keep)
    set({ request: null })
  },
}))
