import {
  getPluginDetails,
  listPlugins,
  type InstalledPlugin,
  type PluginDetails,
} from '@/lib/pluginStore'

/**
 * What the model is told about installed plugins, read from Flint's own plugin
 * state through the same `agent_plugin_*` commands the Plugins panel uses.
 *
 * Two surfaces: `list_plugins` returns the full structured inventory on
 * request, and {@link pluginInventoryLine} puts a one-line summary of what is
 * enabled into the system prompt, so "is the caveman plugin on?" is answered
 * from context instead of by guessing at settings files on disk.
 */

export type PluginInventoryEntry = {
  id: string
  name: string
  /** Where it is installed: every conversation, or one project. */
  scope: 'global' | 'project'
  enabled: boolean
  version: string | null
  description: string
  source: { kind: string; location: string | null } | null
  skills: string[]
  commands: string[]
  agents: string[]
  /**
   * A plugin may ship an MCP server config. Flint does not start it, so there
   * is no connection to report; saying so beats implying one exists.
   */
  mcpServer: 'not-loaded' | null
}

export type PluginInventory = {
  plugins: PluginInventoryEntry[]
  /** Scopes that could not be read, with why. Nothing is guessed for them. */
  errors: { scope: 'global' | 'project'; message: string }[]
}

async function detailsOrNull(
  project: string,
  plugin: InstalledPlugin,
  scope: 'global' | 'project'
): Promise<PluginDetails | null> {
  try {
    return await getPluginDetails(
      project,
      plugin.id,
      scope === 'global' ? 'global' : undefined
    )
  } catch {
    return null
  }
}

function toEntry(
  plugin: InstalledPlugin,
  details: PluginDetails | null,
  scope: 'global' | 'project'
): PluginInventoryEntry {
  return {
    id: plugin.id,
    name: plugin.name || plugin.id,
    scope,
    enabled: plugin.enabled,
    version: plugin.version || null,
    description: plugin.description,
    source: plugin.sourceKind
      ? { kind: plugin.sourceKind, location: plugin.source }
      : null,
    skills: details?.skillNames ?? [],
    commands: details?.commandNames ?? [],
    agents: details?.agentNames ?? [],
    mcpServer: details?.hasMcpConfig ? 'not-loaded' : null,
  }
}

/** Read the inventory: global plugins, plus the attached project's own. */
export async function readPluginInventory(
  projectFolder?: string | null
): Promise<PluginInventory> {
  const inventory: PluginInventory = { plugins: [], errors: [] }
  const scopes: { scope: 'global' | 'project'; project: string }[] = [
    { scope: 'global', project: '' },
  ]
  if (projectFolder) scopes.push({ scope: 'project', project: projectFolder })
  for (const { scope, project } of scopes) {
    try {
      const list = await listPlugins(
        project,
        scope === 'global' ? 'global' : undefined
      )
      const details = await Promise.all(
        list.map((p) => detailsOrNull(project, p, scope))
      )
      list.forEach((p, i) =>
        inventory.plugins.push(toEntry(p, details[i], scope))
      )
    } catch (e) {
      inventory.errors.push({
        scope,
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }
  cached = inventory
  return inventory
}

/** The `list_plugins` tool result. */
export async function listPluginsForModel(
  projectFolder?: string | null
): Promise<string> {
  const inventory = await readPluginInventory(projectFolder)
  return JSON.stringify({
    source: 'Flint plugin state (same as the Plugins panel)',
    count: inventory.plugins.length,
    plugins: inventory.plugins,
    ...(inventory.plugins.length === 0 && inventory.errors.length === 0
      ? { note: 'No plugins are installed.' }
      : {}),
    ...(inventory.errors.length ? { unreadable: inventory.errors } : {}),
  })
}

let cached: PluginInventory | null = null

/** Refresh the cached inventory the system prompt reads. Never throws. */
export async function refreshPluginInventory(
  projectFolder?: string | null
): Promise<void> {
  try {
    await readPluginInventory(projectFolder)
  } catch {
    // Keep the previous inventory; the prompt line says nothing rather than
    // something wrong.
  }
}

/** For tests. */
export function setCachedPluginInventory(inventory: PluginInventory | null) {
  cached = inventory
}

/**
 * One line for the system prompt, or `''` when the inventory is unknown.
 * Names only the enabled plugins and their skills; `list_plugins` has the rest.
 */
export function pluginInventoryLine(): string {
  if (!cached) return ''
  const enabled = cached.plugins.filter((p) => p.enabled)
  const disabled = cached.plugins.filter((p) => !p.enabled)
  const parts: string[] = ['# Plugins']
  if (cached.plugins.length === 0) {
    parts.push('No Flint plugins are installed.')
  } else {
    parts.push(
      enabled.length
        ? 'Enabled Flint plugins: ' +
            enabled
              .map((p) =>
                p.skills.length
                  ? `${p.name} (skills: ${p.skills.slice(0, 8).join(', ')}${
                      p.skills.length > 8 ? ', ...' : ''
                    })`
                  : p.name
              )
              .join('; ') +
            '.'
        : 'No Flint plugins are enabled.'
    )
    if (disabled.length) {
      parts.push(`Installed but disabled: ${disabled.map((p) => p.name).join(', ')}.`)
    }
  }
  parts.push(
    'This list is read from Flint itself. Answer plugin questions from it, or',
    'call list_plugins for details; never search the filesystem for plugin settings.'
  )
  return parts.join(' ')
}
