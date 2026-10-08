/**
 * A one-line hint, once per run, for a model that keeps reading a survey itself.
 *
 * After `NUDGE_AFTER` read-only exploration calls in a row with no delegation,
 * the next tool result carries `NUDGE_TEXT`. It never fires for a short lookup
 * (the streak is never reached), never twice, never after the run has delegated,
 * and never when the run has no delegation tool to point at.
 */
import { TASK_TOOL_NAME, TEAM_TOOL_NAME } from '@/lib/coworkTools'

export const NUDGE_AFTER = 4
export const EXPLORATION_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'ls', 'glob', 'find'])
export const NUDGE_TEXT =
  'Consider dispatching an explorer subagent for the rest of this survey.'

export class DelegationNudge {
  private streak = 0
  private done = false

  /** `offered` is asked on every call, so turning delegation off mid-run stops it. */
  constructor(private readonly offered: () => boolean) {}

  /** Feed one finished tool call; returns the hint when it is time to give it. */
  observe(toolName: string): string | undefined {
    if (this.done || !this.offered()) return undefined
    if (toolName === TASK_TOOL_NAME || toolName === TEAM_TOOL_NAME) {
      // It found the tool on its own.
      this.done = true
      return undefined
    }
    if (!EXPLORATION_TOOLS.has(toolName)) {
      this.streak = 0
      return undefined
    }
    this.streak += 1
    if (this.streak < NUDGE_AFTER) return undefined
    this.done = true
    return NUDGE_TEXT
  }
}

/**
 * A survey the model should not read for itself: it names several areas, or
 * asks for everything of a kind across the repo. Short lookups never match.
 */
const SWEEP =
  /\b(survey|audit|inventory|map out|investigate|go through|every (?:place|file|module|package|usage)|all (?:the |of the )?(?:\w+ )?(?:files|places|usages|tests|modules|packages)|whole (?:repo|codebase|project)|across (?:the )?(?:repo|codebase|project|packages|modules)|for each of|which areas|separately)\b/i

export const SWEEP_HINT =
  'This request is a survey. Your first call must be `task`, one subagent per area, all in one message. Do not read or grep first.'

/** The one-line hint for a survey-shaped request, otherwise undefined. */
export function sweepHint(request: string | undefined): string | undefined {
  const text = request?.trim()
  if (!text || text.length < 40) return undefined
  return SWEEP.test(text) ? SWEEP_HINT : undefined
}
