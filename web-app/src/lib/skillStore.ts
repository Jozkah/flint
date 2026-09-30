import { invoke, previewCall } from '@/lib/previewInvoke'
import {
  skillList,
  skillRead,
  skillWrite,
  skillDelete,
  type SkillMeta as ApiSkillMeta,
} from '@janhq/tauri-plugin-agent-tools-api'
import { getServiceHub } from '@/hooks/useServiceHub'
import { notifySkillsChanged } from '@/lib/skillEvents'

/**
 * A listed skill. `plugin` is set when the skill ships in an enabled plugin
 * installed in the project (`<folder>/.jan/agent/plugins/<plugin>`); its `name`
 * is then `<plugin>:<skill>`. Such a skill is read-only here: the backend
 * refuses writes and deletes addressed to it, because edits belong in the
 * plugin's own source.
 */
export type SkillMeta = ApiSkillMeta & { plugin?: string }

/** Whether a listed skill comes from a plugin, and so cannot be edited here. */
export const isPluginSkill = (skill: Pick<SkillMeta, 'plugin'>): boolean =>
  typeof skill.plugin === 'string' && skill.plugin.length > 0

/**
 * Skill CRUD, for both roots a skill can live under.
 *
 * A skill is the same thing on disk either way -- `<root>/skills/<name>/SKILL.md`
 * -- and Rust runs one implementation for both. Only the root differs, so this is
 * the single place that picks one:
 *
 * - `store`   -- the desktop's permanent store in the Flint data folder, managed
 *                from Settings. Reached through the plugin's guest-js.
 * - `project` -- a project's co-located `<folder>/.jan/agent`, managed from the
 *                code screen.
 *
 * The project scope deliberately keeps using the core `agent_skill_*` commands
 * rather than the plugin's. They are not redundant: `agent_skill_write` also runs
 * `ensure_project`, which scaffolds `agent.toml`. That format is
 * owned by `core::agent::project`, and the plugin must not learn to write it --
 * owning no config format is what let the toolset be extracted at all. Routing
 * project writes through guest-js would silently drop the scaffold.
 */
export type SkillScope =
  | { kind: 'store' }
  | { kind: 'project'; folder: string }

export const storeScope: SkillScope = { kind: 'store' }
export const projectScope = (folder: string): SkillScope => ({
  kind: 'project',
  folder,
})

const dataFolder = async (): Promise<string> => {
  const folder = await getServiceHub().app().getJanDataFolder()
  if (!folder) throw new Error('Flint data folder is unavailable')
  return folder
}

export async function listSkills(scope: SkillScope): Promise<SkillMeta[]> {
  if (scope.kind === 'project') {
    return await invoke<SkillMeta[]>('agent_skill_list', {
      project: scope.folder,
    })
  }
  return (
    (await previewCall<SkillMeta[]>('agent_skill_list', { store: true })) ??
    (await skillList(await dataFolder()))
  )
}

/** Raw SKILL.md text, frontmatter included. */
export async function readSkill(
  scope: SkillScope,
  name: string
): Promise<string> {
  if (scope.kind === 'project') {
    return await invoke<string>('agent_skill_read', {
      project: scope.folder,
      name,
    })
  }
  return (
    (await previewCall<string>('agent_skill_read', { store: true, name })) ??
    (await skillRead(await dataFolder(), name))
  )
}

export async function writeSkill(
  scope: SkillScope,
  name: string,
  content: string
): Promise<void> {
  if (scope.kind === 'project') {
    await invoke('agent_skill_write', {
      project: scope.folder,
      name,
      content,
    })
    notifySkillsChanged()
    return
  }
  await skillWrite(await dataFolder(), name, content)
  notifySkillsChanged()
}

export async function deleteSkill(
  scope: SkillScope,
  name: string
): Promise<void> {
  if (scope.kind === 'project') {
    await invoke('agent_skill_delete', { project: scope.folder, name })
    notifySkillsChanged()
    return
  }
  await skillDelete(await dataFolder(), name)
  notifySkillsChanged()
}
