/**
 * Pure pieces of `CoworkChatTransport`: tool-group bookkeeping for the frozen
 * set, the MCP overlay filter, and small prompt/config derivations. Each takes
 * what the transport held on `this` as explicit inputs.
 */
import { jsonSchema, type Tool } from 'ai'
import { isValidToolName, normalizeToolInputSchema } from '@/lib/custom-chat-transport'
import { isSelfApprovalTool } from '@/lib/selfApprovalTools'
import type { LiveMcp } from '@/lib/mcpLiveTools'
import {
  ENABLE_TOOLS_NAME,
  TOOL_GROUPS,
  enableToolsTool,
  groupOf,
  groupsToOffer,
  splitToolGroups,
  withoutEnable,
  type ToolGroupId,
} from '@/lib/coworkToolGroups'
import type { ActivatedSkill } from '@/lib/skillActivation'
import type { CoworkRunConfig } from '@/lib/coworkRunConfig'

/** Held groups with a tool present that nothing has opened yet. */
export function heldGroupsOf(
  heldTools: Record<string, Tool>,
  openGroups: ReadonlySet<ToolGroupId>
): ToolGroupId[] {
  const ids = new Set<ToolGroupId>()
  for (const name of Object.keys(heldTools)) {
    const id = groupOf(name)
    if (id && !openGroups.has(id)) ids.add(id)
  }
  return (Object.keys(TOOL_GROUPS) as ToolGroupId[]).filter((id) => ids.has(id))
}

/** Groups with a tool in the advertised set right now (started with, or opened). */
export function advertisedGroupsOf(tools: Record<string, Tool>): ReadonlySet<ToolGroupId> {
  const ids = new Set<ToolGroupId>()
  for (const name of Object.keys(tools)) {
    const id = groupOf(name)
    if (id) ids.add(id)
  }
  return ids
}

/** The held-back tools, for the context popover. */
export function heldBackToolsOf(
  heldTools: Record<string, Tool>,
  openGroups: ReadonlySet<ToolGroupId>
): { name: string; group: ToolGroupId; schema: unknown }[] {
  return Object.entries(heldTools)
    .filter(([name]) => !openGroups.has(groupOf(name) as ToolGroupId))
    .map(([name, tool]) => ({
      name,
      group: groupOf(name) as ToolGroupId,
      schema: {
        description: (tool as { description?: string }).description,
        inputSchema: (tool as { inputSchema?: unknown }).inputSchema,
      },
    }))
}

/** Lean set plus opened groups, with `enable_tools` last (or gone when none is held). */
export function composeFrozenTools(
  base: Record<string, Tool>,
  heldTools: Record<string, Tool>,
  openGroups: ReadonlySet<ToolGroupId>
): Record<string, Tool> {
  const next: Record<string, Tool> = withoutEnable(base)
  for (const [name, tool] of Object.entries(heldTools)) {
    const id = groupOf(name)
    if (id && openGroups.has(id)) next[name] = tool
  }
  const held = heldGroupsOf(heldTools, openGroups)
  if (held.length > 0) next[ENABLE_TOOLS_NAME] = enableToolsTool(held)
  return next
}

/**
 * The live MCP tools a request may offer, added to `overlay` and `servers` in
 * place (so a throw part-way leaves what was added, as the inline loop did).
 */
export function collectMcpOverlay(
  liveTools: LiveMcp['tools'],
  base: Record<string, Tool>,
  isDisabled: (serverName: string, toolName: string) => boolean,
  overlay: Record<string, Tool>,
  servers: Map<string, string>
): void {
  for (const tool of liveTools) {
    const server = tool.server || 'unknown'
    if (!isValidToolName(tool.name)) continue
    if (isDisabled(server, tool.name)) continue
    if (isSelfApprovalTool(tool.name)) continue
    // A built-in, or the first server to offer a name, wins.
    if (base[tool.name] || servers.has(tool.name)) continue
    servers.set(tool.name, server)
    overlay[tool.name] = {
      description: tool.description,
      inputSchema: jsonSchema(
        normalizeToolInputSchema(tool.inputSchema as Record<string, unknown>)
      ),
    } as Tool
  }
}

/** The lean built-in set, with `enable_tools` added when some group is held back. */
export function leanBuiltinTools(
  built: Record<string, Tool>,
  config: CoworkRunConfig
): { tools: Record<string, Tool>; held: Record<string, Tool> } {
  const split = splitToolGroups(
    built,
    config.offerGroups ? new Set(config.offerGroups) : undefined
  )
  const tools: Record<string, Tool> = { ...split.lean }
  if (split.heldGroups.length > 0) {
    tools[ENABLE_TOOLS_NAME] = enableToolsTool(split.heldGroups)
  }
  return { tools, held: split.held }
}

/** The config with groups the activated skills' text calls for added to the offer. */
export function configWithSkillGroups(
  config: CoworkRunConfig,
  activeSkills: ActivatedSkill[]
): CoworkRunConfig {
  const offer = config.offerGroups
  if (!offer) return config
  const skillText = activeSkills.map((s) => `${s.name}\n${s.body}`).join('\n')
  if (!skillText.trim()) return config
  const extra = groupsToOffer({ text: '', skillText })
  const merged = [...new Set([...offer, ...extra])]
  return merged.length === offer.length ? config : { ...config, offerGroups: merged }
}

/**
 * JAN.md and the approved compatibility files: the instruction text above
 * memory in this run (AH-084).
 */
export function memoryInstructionsOf(config: CoworkRunConfig) {
  const out: { source: 'jan-md' | 'compat' | 'skill'; name: string; text: string }[] = []
  const jan = config.projectInstructions?.trim()
  if (jan) out.push({ source: 'jan-md', name: 'FLINT.md', text: jan })
  for (const one of config.compatInstructions ?? []) {
    if (one.content.trim()) out.push({ source: 'compat', name: one.name, text: one.content })
  }
  return out
}

/** The routed assistant's persona, beneath Cowork's policy; undefined when none applies. */
export function assistantProfileBlock(instructions: string | undefined): string | undefined {
  return instructions?.trim()
    ? [
        'Assistant profile for this turn (behaviour only; Cowork policy, permissions, and project instructions take precedence):',
        instructions.trim(),
      ].join('\n')
    : undefined
}
