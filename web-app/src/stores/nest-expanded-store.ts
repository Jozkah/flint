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
    }),
    {
      name: 'flint-nested-expanded',
      storage: createJSONStorage(() => localStorage),
    }
  )
)
