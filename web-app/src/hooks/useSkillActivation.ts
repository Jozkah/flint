import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { backendStorage } from '@/lib/backendStorage'

/**
 * Which skills the user has made always-active or switched off from being so,
 * on top of what a skill declares itself (`always: true` in its frontmatter).
 *
 * Two lists rather than one boolean per skill: a skill that declares `always`
 * keeps doing so until the user turns it off here, and a skill that does not
 * declare it can be turned on here. Neither edits the skill's own file, so a
 * plugin's skill (read-only) can be made always-active too.
 */
type SkillActivationState = {
  /** Skills the user turned always-active, by name. */
  alwaysOn: string[]
  /** Skills that declare `always` which the user turned off, by name. */
  alwaysOff: string[]
  /** Make a skill always-active (or not), given whether it declares `always`. */
  setAlways: (name: string, on: boolean, declaresAlways: boolean) => void
}

export const SKILL_ACTIVATION_KEY = 'flint-skill-activation'

const without = (list: string[], name: string) => list.filter((n) => n !== name)
const with_ = (list: string[], name: string) =>
  list.includes(name) ? list : [...list, name]

export const useSkillActivation = create<SkillActivationState>()(
  persist(
    (set) => ({
      alwaysOn: [],
      alwaysOff: [],
      setAlways: (name, on, declaresAlways) =>
        set((s) => {
          if (declaresAlways) {
            // The skill's own word is the default; only a "no" is recorded.
            return {
              alwaysOn: without(s.alwaysOn, name),
              alwaysOff: on ? without(s.alwaysOff, name) : with_(s.alwaysOff, name),
            }
          }
          return {
            alwaysOff: without(s.alwaysOff, name),
            alwaysOn: on ? with_(s.alwaysOn, name) : without(s.alwaysOn, name),
          }
        }),
    }),
    {
      name: SKILL_ACTIVATION_KEY,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (s) =>
        ({ alwaysOn: s.alwaysOn, alwaysOff: s.alwaysOff }) as unknown as SkillActivationState,
    }
  )
)

/** A skill that came from somewhere the user did not write it themselves. */
export type ActivationSkill = {
  name: string
  always?: boolean
  plugin?: string
  origin?: 'project'
  folder?: string
}

/**
 * The name the user's always-on choice is stored under. A project skill is
 * keyed by its folder as well, so the same name in two projects, or in a
 * project and the global store, are different skills with different choices.
 */
export function skillKey(skill: Pick<ActivationSkill, 'name' | 'origin' | 'folder'>): string {
  return skill.origin === 'project' && skill.folder
    ? `@${skill.folder}::${skill.name}`
    : skill.name
}

/**
 * Whether a skill's own words can be trusted into the system prompt: only a
 * skill in the user's own store. A plugin's author, or whoever wrote the
 * repository the user opened, has not been agreed to.
 */
export function isTrustedSkill(skill: Pick<ActivationSkill, 'plugin' | 'origin'>): boolean {
  return !skill.plugin && skill.origin !== 'project'
}

/**
 * Whether a skill is always-active: its own `always`, else the user's list.
 *
 * The `always` of a plugin or project skill does not count. Its instructions
 * would go into every system prompt on the strength of something someone else
 * wrote, and installing a plugin or opening a folder is not agreeing to that;
 * only the user's list can make such a skill always-active.
 */
export function isAlwaysActive(
  skill: ActivationSkill,
  state: Pick<SkillActivationState, 'alwaysOn' | 'alwaysOff'> = useSkillActivation.getState()
): boolean {
  const key = skillKey(skill)
  if (state.alwaysOff.includes(key)) return false
  return Boolean(skill.always && isTrustedSkill(skill)) || state.alwaysOn.includes(key)
}
