import { create } from 'zustand'

/**
 * Visibility of the JAN -> Flint migration assistant.
 *
 * Kept in a tiny store so the first-launch trigger and the Settings entry
 * ("import later") can both open the same assistant. `openedManually` lets the
 * assistant tell a Settings-initiated open (show a "no legacy data" state) from
 * the automatic first-launch open (which only ever fires when data was found).
 */
type MigrationAssistantState = {
  open: boolean
  openedManually: boolean
  openAssistant: () => void
  closeAssistant: () => void
}

export const useMigrationAssistant = create<MigrationAssistantState>((set) => ({
  open: false,
  openedManually: false,
  openAssistant: () => set({ open: true, openedManually: true }),
  closeAssistant: () => set({ open: false }),
}))
