import { invoke } from '@tauri-apps/api/core'
import type { SlashCatalogEntry } from '@/lib/slashCommands'

/** Where a composer lives. Cowork passes its folder as `project`. */
export type SlashSurface = 'home' | 'rooms' | 'cowork'

/**
 * What the `/` menu offers on a surface (`agent_slash_catalog`): plugin
 * commands with their bodies and user-invocable skills, already filtered by
 * the per-surface enablement toggles.
 */
export const loadSlashCatalog = async (
  surface: SlashSurface,
  project?: string | null
): Promise<SlashCatalogEntry[]> => {
  try {
    const entries = await invoke<SlashCatalogEntry[]>('agent_slash_catalog', {
      surface,
      project: project ?? null,
    })
    return Array.isArray(entries) ? entries : []
  } catch {
    // No backend (web build, tests): built-ins still work.
    return []
  }
}

/** The message that invokes a skill with `args` as its task. Rejects when the surface does not offer it. */
export const invokeSlashSkill = (
  surface: SlashSurface,
  project: string | null | undefined,
  name: string,
  args: string
) =>
  invoke<string>('agent_slash_invoke_skill', {
    surface,
    project: project ?? null,
    name,
    args,
  })
