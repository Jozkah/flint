import { create } from 'zustand'
import type { ConversationGroup, GroupSurface } from './types'
import type { JoinChoice } from './inherit'

type KeepRequest = {
  surface: GroupSurface
  groupName: string
  paths: string[]
  resolve: (keep: boolean) => void
}

type JoinRequest = {
  surface: GroupSurface
  group: ConversationGroup
  own: string[]
  resolve: (choice: JoinChoice) => void
}

type GroupPromptStore = {
  request: KeepRequest | null
  join: JoinRequest | null
  /** Ask whether an item leaving a group keeps the folders it inherited. */
  ask: (surface: GroupSurface, groupName: string, paths: string[]) => Promise<boolean>
  answer: (keep: boolean) => void
  /** Ask how an item's folders and a group's combine when it joins. */
  askJoin: (
    surface: GroupSurface,
    own: string[],
    group: ConversationGroup
  ) => Promise<JoinChoice>
  answerJoin: (choice: JoinChoice) => void
}

/**
 * The folder questions a group move asks, from a drag or a row menu, and
 * answered in the dialogs `GroupPrompts` renders for the surface.
 */
export const useKeepFoldersPrompt = create<GroupPromptStore>()((set, get) => ({
  request: null,
  join: null,
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
  askJoin: (surface, own, group) =>
    new Promise<JoinChoice>((resolve) => {
      get().join?.resolve('cancel')
      set({ join: { surface, group, own, resolve } })
    }),
  answerJoin: (choice) => {
    get().join?.resolve(choice)
    set({ join: null })
  },
}))
