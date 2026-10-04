/**
 * Which assistant, work profile and model a spawned subagent runs with.
 *
 * One pure rule, shared by every spawn path (Cowork `task`/`team`, plain chat,
 * Rooms), mirrored by `resolve_child_choice` in `core/agent/subagent.rs` for the
 * Rust dispatch:
 *
 *   explicit tool argument (when "Let the model choose" is on)
 *     > the role's own setting
 *     > the global subagent setting
 *     > inherit the parent's.
 *
 * Each field resolves on its own, so a role can set only a model and still
 * inherit the assistant. Nothing here touches tools or permissions: a child's
 * allowlist stays the intersection of its definition, the call and the parent's
 * (`intersectAllowedTools`), whatever these settings say.
 */
import type { WorkProfileId } from '@/lib/workProfiles'

export type ModelRef = { provider: string; id: string }

/** What one level of the rule can set. An absent field means "inherit". */
export type SubagentPick = {
  assistantId?: string
  workProfile?: WorkProfileId
  model?: ModelRef
}

export type SubagentSettings = {
  /** Whether arguments the calling model supplied outrank these settings. */
  letModelChoose: boolean
  global: SubagentPick
  roles: Record<string, SubagentPick>
}

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
  letModelChoose: true,
  global: {},
  roles: {},
}

/** Where a resolved value came from, for the row chip's tooltip. */
export type ChoiceSource = 'tool' | 'role' | 'global' | 'parent'

export type Resolved<T> = { value: T | undefined; source: ChoiceSource }

export type SubagentChoice = {
  assistantId: Resolved<string>
  workProfile: Resolved<WorkProfileId>
  model: Resolved<ModelRef>
}

const FIELDS = ['assistantId', 'workProfile', 'model'] as const

/** Resolve one subagent's assistant, work profile and model. */
export function resolveSubagentChoice(input: {
  settings: SubagentSettings
  /** The role or saved-agent name the call resolved to. */
  role: string
  /** Arguments the calling model supplied explicitly. */
  requested?: SubagentPick
  /** What the parent run itself is using. */
  parent?: SubagentPick
}): SubagentChoice {
  const { settings, role } = input
  const out = {} as Record<(typeof FIELDS)[number], Resolved<unknown>>
  for (const field of FIELDS) {
    const asked = settings.letModelChoose ? input.requested?.[field] : undefined
    const forRole = settings.roles[role]?.[field]
    const global = settings.global[field]
    if (asked !== undefined) out[field] = { value: asked, source: 'tool' }
    else if (forRole !== undefined) out[field] = { value: forRole, source: 'role' }
    else if (global !== undefined) out[field] = { value: global, source: 'global' }
    else out[field] = { value: input.parent?.[field], source: 'parent' }
  }
  return out as unknown as SubagentChoice
}

/** True when the pick sets nothing, so the card can show "Inherit" throughout. */
export function isEmptyPick(pick: SubagentPick | undefined): boolean {
  return !pick || (pick.assistantId === undefined && pick.workProfile === undefined && pick.model === undefined)
}

/**
 * The notes added to a child's system prompt for a chosen assistant or profile.
 * They say what they are not: nothing here changes which tools or approvals the
 * child has, so a prompt cannot be used to talk past the run's permissions.
 */
export const PERMISSION_NOTE =
  'This shapes how you work only. It does not change which tools you have or what you may do without asking.'

export function assistantBlock(instructions: string | undefined): string | undefined {
  const text = instructions?.trim()
  if (!text) return undefined
  return ['Assistant profile for this task (behaviour only):', text, PERMISSION_NOTE].join('\n')
}

export function profileBlock(block: string | undefined): string | undefined {
  const text = block?.trim()
  return text ? `${text}\n\n${PERMISSION_NOTE}` : undefined
}
