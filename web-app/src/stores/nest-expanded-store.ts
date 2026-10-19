import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * Which sidebar parents the person unfolded (every nested row shown), keyed
 * `<list>:<parent id>`. A per-viewer view choice, kept in this browser only and
 * never in the chat or session data. Absent means folded (the default).
 */
type NestExpandedState = {
  expanded: Record<string, true>
  toggle: (key: string) => void
  /** Drop the unfolded flag of parents that no longer exist. */
  forget: (scope: string, parentIds: readonly string[]) => void
}

export const useNestExpanded = create<NestExpandedState>()(
  persist(
    (set) => ({
      expanded: {},
      toggle: (key) =>
        set((s) => {
          const expanded = { ...s.expanded }
          if (expanded[key]) delete expanded[key]
          else expanded[key] = true
          return { expanded }
        }),
      forget: (scope, parentIds) =>
        set((s) => {
          const gone = parentIds.map((id) => `${scope}:${id}`).filter((k) => s.expanded[k])
          if (gone.length === 0) return s
          const expanded = { ...s.expanded }
          for (const k of gone) delete expanded[k]
          return { expanded }
        }),
    }),
    {
      name: 'flint-nested-expanded',
      storage: createJSONStorage(() => localStorage),
    }
  )
)
