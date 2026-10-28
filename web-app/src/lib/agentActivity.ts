import type { CoworkTurn, SubagentRun } from '@/types/coworkSession'
import { i18n } from '@/i18n/react-i18next-compat'

export type ActivityLabel = { text: string; startedAt: number } | null

const MAX_COMMAND_LEN = 60

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1) || normalized
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function stringArg(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function humanizeToolName(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').trim()
  if (!spaced) return 'tool'
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const VERB_TOOLS = new Set(['write', 'edit', 'bash', 'read', 'ls', 'find', 'grep'])

const NO_DETAIL_TOOLS: Record<string, string> = {
  memory_write: 'savingMemory',
  memory_read: 'readingMemory',
  memory_list: 'readingMemory',
}

/** Text for one tool call, given its name and args. Pure formatting, no timestamp. */
export function toolActivityText(toolName: string, input: unknown): string {
  const fixed = NO_DETAIL_TOOLS[toolName]
  if (fixed) return i18n.t(`common:activity.${fixed}`)

  if (toolName === 'skill_read') {
    const name = stringArg(input, 'name')
    return name ? i18n.t('common:activity.readingSkillNamed', { name }) : i18n.t('common:activity.readingSkill')
  }

  if (!VERB_TOOLS.has(toolName)) return humanizeToolName(toolName)
  const verb = i18n.t(`common:activity.verb.${toolName}`)

  if (toolName === 'bash') {
    const command = stringArg(input, 'command')
    return command
      ? i18n.t(`common:activity.verbTarget.${toolName}`, { target: truncate(command, MAX_COMMAND_LEN) })
      : verb
  }

  const path = stringArg(input, 'path')
  return path ? i18n.t(`common:activity.verbTarget.${toolName}`, { target: basename(path) }) : verb
}

export function completedToolLabel(
  toolName: string,
  input: unknown,
  state: string
): string {
  if (toolName === 'skill_read' && state === 'output-available') {
    const name = stringArg(input, 'name')
    return name ? i18n.t('common:activity.usedSkillNamed', { name }) : i18n.t('common:activity.usedSkill')
  }
  return toolActivityText(toolName, input)
}

type ToolPartLike = {
  type: string
  state?: string
  input?: unknown
}

export function usedSkillNames(parts: ToolPartLike[]): string[] {
  const names = new Set<string>()
  for (const part of parts) {
    if (part.type !== 'tool-skill_read' || part.state !== 'output-available') {
      continue
    }
    const name = stringArg(part.input, 'name')
    if (name) names.add(name)
  }
  return [...names]
}

function lastRunningToolTurn(turns: CoworkTurn[]): CoworkTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn.role === 'tool' && turn.status === 'running') return turn
  }
  return undefined
}

/** null if no subagent is running; else a combined label + earliest startedAt. */
export function subagentActivityLabel(subagents: SubagentRun[]): ActivityLabel {
  const running = subagents.filter((s) => s.status === 'running')
  if (running.length === 0) return null

  if (running.length === 1) {
    const run = running[0]
    const activeTurn = lastRunningToolTurn(run.turns)
    const detail = activeTurn
      ? toolActivityText(activeTurn.name ?? 'tool', activeTurn.args)
      : i18n.t('common:activity.working')
    return { text: `${run.name}: ${detail}`, startedAt: run.startedAt }
  }

  const startedAt = Math.min(...running.map((s) => s.startedAt))
  return { text: i18n.t('common:activity.subagentsWorking', { count: running.length }), startedAt }
}

/**
 * Whether a running agent is waiting on the model with nothing to show for it.
 *
 * True in the two gaps an agent loop leaves: before the first token, and again
 * after each tool result. Streaming text and a running tool already report
 * themselves, so a generic "Working…" beside them is noise.
 */
export function awaitsModel(running: boolean, turns: CoworkTurn[]): boolean {
  if (!running) return false
  const last = turns.at(-1)
  if (!last) return true
  if (last.role === 'user') return true
  return last.role === 'tool' && last.status === 'done'
}
