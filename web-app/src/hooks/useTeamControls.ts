import { create } from 'zustand'
import type { TeamControl } from '@/lib/coworkTeamControl'

/**
 * The control of every team that is running right now, by its team task id
 * (AH-111).
 *
 * Not persisted, on purpose: a control reaches a team only while the run that
 * owns it is alive. What a person did with it -- a restart, a replacement --
 * is recorded on the task in the persisted activity record, so it survives a
 * restart; the control itself cannot, because the team it steered does not.
 */
type TeamControlsState = {
  controls: Record<string, TeamControl>
  register: (teamTaskId: string, control: TeamControl) => void
  unregister: (teamTaskId: string) => void
}

export const useTeamControls = create<TeamControlsState>()((set) => ({
  controls: {},
  register: (teamTaskId, control) =>
    set((s) => ({ controls: { ...s.controls, [teamTaskId]: control } })),
  unregister: (teamTaskId) =>
    set((s) => {
      const next = { ...s.controls }
      delete next[teamTaskId]
      return { controls: next }
    }),
}))
