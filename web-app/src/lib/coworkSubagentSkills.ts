/**
 * Skills a subagent definition preloads (`skills`).
 *
 * Each named skill is read through the child's own dispatcher with the same
 * `skill_read` tool the model would call, so the skill whitelist, the
 * model-invocation switch and the needs-a-denied-tool check all apply exactly
 * as they do for a call. A skill that cannot be read is a launch error that
 * names it: a child that silently lost its procedure would improvise one.
 *
 * Preloading grants nothing. The content is instructions in the child's
 * system prompt; every tool it mentions still runs through the child's gate.
 */
import type { PendingToolCall, ToolOutcome } from '@/lib/coworkRunner'

/** Most skills one definition may preload. */
export const MAX_PRELOADED_SKILLS = 32

/** A definition's `skills` value, cleaned: trimmed, deduped, in order. */
export function parseSkillList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const names: string[] = []
  for (const v of value) {
    if (typeof v !== 'string') continue
    const name = v.trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names.length > 0 ? names : undefined
}

/** The error for a list over the cap, else null. */
export function skillListError(names: readonly string[]): string | null {
  return names.length > MAX_PRELOADED_SKILLS
    ? `subagent preloads ${names.length} skills; the limit is ${MAX_PRELOADED_SKILLS}`
    : null
}

export type PreloadedSkills = { blocks: string[] } | { error: string }

/** One system-prompt block for a preloaded skill. */
export function skillBlock(name: string, content: string): string {
  return `<preloaded-skill name="${name.replace(/"/g, '')}">\n${content.trim()}\n</preloaded-skill>`
}

/** Read every named skill; the first one that cannot be read ends it. */
export async function preloadSkills(
  names: readonly string[],
  dispatch: (call: PendingToolCall, signal: AbortSignal) => Promise<ToolOutcome>,
  signal: AbortSignal
): Promise<PreloadedSkills> {
  const tooMany = skillListError(names)
  if (tooMany) return { error: tooMany }
  const blocks: string[] = []
  for (const name of names) {
    let outcome: ToolOutcome
    try {
      outcome = await dispatch(
        { toolCallId: `preload-skill:${name}`, toolName: 'skill_read', input: { name } },
        signal
      )
    } catch (e) {
      return { error: `skill '${name}' could not be loaded: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (outcome.isError || /^ERROR\b/.test(outcome.output)) {
      return { error: `skill '${name}' could not be preloaded: ${outcome.output.replace(/^ERROR\s*(\[[^\]]*\])?:?\s*/, '').trim() || 'not found'}` }
    }
    blocks.push(skillBlock(name, outcome.output))
  }
  return { blocks }
}
