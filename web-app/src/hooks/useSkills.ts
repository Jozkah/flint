import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { toast } from 'sonner'
import * as skillStore from '@/lib/skillStore'
import type { SkillMeta } from '@/lib/skillStore'

export type { SkillMeta }
export type HubSkill = { name: string; description: string }

// The `[skills].enabled` whitelist uses three shapes:
//   []          -> all skills enabled (scaffold default; backward compatible)
//   ['a','b']   -> only the named skills
//   [SKILLS_NONE] -> no skills enabled
// SKILLS_NONE is the empty string, which a real skill name can never be (skill
// names are non-empty file/folder stems). The backend already advertises nothing
// for a whitelist that matches no real skill, so this needs no backend special
// case — it just makes "none" representable, unlike a bare [] (which means all).
export const SKILLS_NONE = ''

/**
 * Does one whitelist entry enable the skill named `skillName`?
 *
 * Mirrors `entry_enabled` in the agent-tools crate, which is what actually
 * decides what the agent is offered: an entry matches the full name, and for
 * a plugin skill (`<plugin>:<skill>`) also its plain skill name or the plugin
 * id alone (which enables every skill that plugin ships).
 */
export function whitelistMatches(entry: string, skillName: string): boolean {
  if (entry === SKILLS_NONE) return false
  if (entry === skillName) return true
  const colon = skillName.indexOf(':')
  if (colon < 0) return false
  return (
    entry === skillName.slice(0, colon) || entry === skillName.slice(colon + 1)
  )
}

/** Resolve the stored whitelist to the set of skills actually enabled. */
export function effectiveEnabled(
  enabled: string[],
  allNames: string[]
): Set<string> {
  if (enabled.length === 0) return new Set(allNames)
  // Stale entries (a since-deleted skill, a removed plugin) and the sentinel
  // match nothing, so they drop out here.
  return new Set(
    allNames.filter((name) =>
      enabled.some((entry) => whitelistMatches(entry, name))
    )
  )
}

/** Encode a desired enabled-set back into the stored whitelist shape. */
export function storedEnabled(next: Set<string>, allNames: string[]): string[] {
  if (next.size >= allNames.length) return [] // all -> canonical empty
  if (next.size === 0) return [SKILLS_NONE] // none -> sentinel
  return [...next]
}

// Shared mutation counter so every useSkills instance (e.g. the manager dialog
// and the input's SkillSelector) re-fetches when any of them changes a skill.
const useSkillsVersion = create<{ v: number; bump: () => void }>((set) => ({
  v: 0,
  bump: () => set((s) => ({ v: s.v + 1 })),
}))

/**
 * Make every mounted `useSkills` re-fetch.
 *
 * For changes made outside the skill CRUD itself -- installing, enabling,
 * disabling or removing a plugin changes which plugin skills exist -- so the
 * selector and the manager never show a list the backend no longer offers.
 */
export function invalidateSkills(): void {
  useSkillsVersion.getState().bump()
}

/**
 * CRUD over the agent's per-project skills (`<folder>/.jan/agent/skills/*.md`).
 * Storage is shared with the settings page's permanent store via `skillStore`;
 * only the root differs. The `[skills].enabled` whitelist and the skill hub stay
 * on their own commands -- both are project concerns with no store equivalent.
 * All operations are scoped to `folder`; with no folder there are no skills.
 */
export function useSkills(folder: string | null) {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  // Enabled-skill whitelist from `[skills].enabled`; empty = all skills enabled.
  const [enabled, setEnabledState] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const version = useSkillsVersion((s) => s.v)
  const bump = useSkillsVersion((s) => s.bump)
  // Mirrors `enabled` so `setEnabled` can roll back to the last known value after
  // an await without depending on (and being recreated by) the state itself.
  const enabledRef = useRef<string[]>([])

  const scope = useMemo(
    () => (folder ? skillStore.projectScope(folder) : null),
    [folder]
  )

  const refresh = useCallback(async () => {
    if (!folder || !scope) {
      setSkills([])
      setEnabledState([])
      enabledRef.current = []
      return
    }
    setLoading(true)
    try {
      const [list, en] = await Promise.all([
        skillStore.listSkills(scope),
        invoke<string[]>('agent_skill_enabled_get', { project: folder }),
      ])
      setSkills(list)
      setEnabledState(en)
      enabledRef.current = en
    } catch (e) {
      // A discovery failure must be actionable, not a silently empty list (#8878).
      toast.error(String(e))
    } finally {
      setLoading(false)
    }
  }, [folder, scope])

  // Persist the enabled whitelist (empty = all). Optimistic local update; on a
  // write failure, roll back so the UI never diverges from the on-disk config.
  // Errors are surfaced and swallowed here so fire-and-forget callers (e.g. the
  // SkillSelector toggle) don't produce unhandled rejections.
  const setEnabled = useCallback(
    async (names: string[]) => {
      const prev = enabledRef.current
      setEnabledState(names)
      enabledRef.current = names
      try {
        await invoke('agent_skill_enabled_set', {
          project: folder,
          enabled: names,
        })
        bump()
      } catch (e) {
        setEnabledState(prev)
        enabledRef.current = prev
        toast.error(String(e))
      }
    },
    [folder, bump]
  )

  // Re-fetch on folder change AND whenever any instance mutates skills.
  useEffect(() => {
    refresh()
  }, [refresh, version])

  // Callers reach these only from surfaces that already require a folder; the
  // guard keeps that an explicit failure rather than a silent write to the
  // wrong root.
  const requireScope = useCallback(() => {
    if (!scope) throw new Error('No project folder selected')
    return scope
  }, [scope])

  const read = useCallback(
    (name: string) => skillStore.readSkill(requireScope(), name),
    [requireScope]
  )

  const write = useCallback(
    async (name: string, content: string) => {
      await skillStore.writeSkill(requireScope(), name, content)
      bump()
    },
    [requireScope, bump]
  )

  const remove = useCallback(
    async (name: string) => {
      await skillStore.deleteSkill(requireScope(), name)
      bump()
    },
    [requireScope, bump]
  )

  // Anthropic skill hub. `hubList` is project-independent; `hubImport` downloads
  // into the current folder, then bumps so all instances re-fetch.
  const hubList = useCallback(
    () => invoke<HubSkill[]>('agent_skill_hub_list'),
    []
  )

  const hubImport = useCallback(
    async (name: string) => {
      await invoke('agent_skill_hub_import', { project: folder, name })
      bump()
    },
    [folder, bump]
  )

  return {
    skills,
    enabled,
    setEnabled,
    loading,
    refresh,
    read,
    write,
    remove,
    hubList,
    hubImport,
  }
}
