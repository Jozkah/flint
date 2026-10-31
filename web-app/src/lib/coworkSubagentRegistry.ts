import { invokeCommand as invoke } from '@/lib/backend'

/**
 * The saved subagent definitions available to a Cowork run.
 *
 * Desktop keeps a single directory (`<janDataFolder>/agent-workspace/subagents`)
 * rather than the CLI's plugin/user/project merge: a default session has no
 * project root, and an attached folder is mounted read-only, so scanning it
 * would let a cloned repo inject a system prompt and a tool allowlist into the
 * agent. See `core/agent/subagent.rs::desktop_subagents_dir`.
 *
 * Field names stay snake_case because the same JSON shape is what the `task`
 * tool receives from the model.
 */
export type SubagentDefinition = {
  name: string
  description: string
  system_prompt: string
  /** Narrows the child's toolset. `null` inherits the parent's. */
  allowed_tools: string[] | null
  model: string | null
  /**
   * `builtin` for a role Flint ships (AH-094..099), `user` for one saved here.
   * A saved definition of the same name replaces the built-in.
   */
  scope?: 'builtin' | 'user' | 'project' | 'plugin'
  /**
   * Optional per-agent options. Every one is absent by default, and an absent
   * option is the behaviour a definition without it always had. They mirror
   * `SubagentOptions` in `core/agent/subagent.rs`.
   */
  /** Tools removed before `allowed_tools` applies. */
  disallowed_tools?: string[]
  /** Step cap for this agent, clamped to [1, MAX_SUBAGENT_STEPS]. */
  max_turns?: number
  /** A cowork mode for the child; it can tighten the parent's, never loosen it. */
  permission_mode?: 'review' | 'ask' | 'auto' | 'bypass'
  /** Run in the background unless the `task` call says otherwise. */
  background?: boolean
  /** `worktree`: its own checkout unless the `task` call says otherwise. */
  isolation?: 'worktree'
  /** Prepended to the parent's delegation message. */
  initial_prompt?: string
  /** Skip project instructions (JAN.md and compatible files). */
  omit_instructions?: boolean
  /** Skills whose full content is preloaded into the child's context (max 32). */
  skills?: string[]
  /** A persistent memory directory of its own (in the data folder, never in a project). */
  memory?: 'user' | 'project'
  /** Reasoning effort for this agent, where its model offers one. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh'
}

let cache: SubagentDefinition[] | null = null

/**
 * Saved definitions, cached for the app's lifetime.
 *
 * Never throws: an unreadable directory or a missing command costs the run its
 * saved names, not the run itself — a one-off subagent with an inline
 * `system_prompt` still works, which is how the `task` tool stays usable.
 */
export async function listSubagents(): Promise<SubagentDefinition[]> {
  if (cache) return cache
  try {
    cache = await invoke<SubagentDefinition[]>('agent_subagent_list')
  } catch {
    // Not cached: a transient failure must not hide saved definitions until
    // restart (F7x1-010).
    return []
  }
  return cache
}

/** Drop the cache so a newly written definition shows up without a restart. */
export function refreshSubagents(): void {
  cache = null
}

export const __testing = {
  reset: () => {
    cache = null
  },
}
