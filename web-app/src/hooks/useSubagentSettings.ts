import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { backendStorage } from '@/lib/backendStorage'
import {
  DEFAULT_SUBAGENT_SETTINGS,
  isEmptyPick,
  type SubagentPick,
  type SubagentSettings,
} from '@/lib/subagentSettings'

type State = SubagentSettings & {
  setLetModelChoose: (value: boolean) => void
  /** Set one field of the global pick; `undefined` goes back to inheriting. */
  setGlobal: <K extends keyof SubagentPick>(field: K, value: SubagentPick[K] | undefined) => void
  /** Set one field of a role's pick; `undefined` goes back to inheriting. */
  setRole: <K extends keyof SubagentPick>(role: string, field: K, value: SubagentPick[K] | undefined) => void
  reset: () => void
}

export const SUBAGENT_SETTINGS_KEY = 'flint-subagent-settings'

function withField<K extends keyof SubagentPick>(
  pick: SubagentPick | undefined,
  field: K,
  value: SubagentPick[K] | undefined
): SubagentPick {
  const next = { ...(pick ?? {}) }
  if (value === undefined) delete next[field]
  else next[field] = value
  return next
}

/** Persisted like the other agent settings (see `useAgentToolsConfig`). */
export const useSubagentSettings = create<State>()(
  persist(
    (set) => ({
      ...DEFAULT_SUBAGENT_SETTINGS,
      setLetModelChoose: (letModelChoose) => set({ letModelChoose }),
      setGlobal: (field, value) => set((s) => ({ global: withField(s.global, field, value) })),
      setRole: (role, field, value) =>
        set((s) => {
          const roles = { ...s.roles }
          const pick = withField(roles[role], field, value)
          if (isEmptyPick(pick)) delete roles[role]
          else roles[role] = pick
          return { roles }
        }),
      reset: () => set({ ...DEFAULT_SUBAGENT_SETTINGS }),
    }),
    {
      name: SUBAGENT_SETTINGS_KEY,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (s) =>
        ({ letModelChoose: s.letModelChoose, global: s.global, roles: s.roles }) as unknown as State,
    }
  )
)

/** The settings alone, for the resolver. */
export function currentSubagentSettings(): SubagentSettings {
  const s = useSubagentSettings.getState()
  return { letModelChoose: s.letModelChoose, global: s.global, roles: s.roles }
}
