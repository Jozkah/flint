/**
 * One question before an editing subagent first runs in a session.
 *
 * A child that can write, edit or run commands will put each of those to the
 * user anyway when the session is in `ask`; this asks once up front who is
 * about to be given that, by name, tools and model, so the first prompt is not
 * the first the user hears of it. Remembered per session and definition: a
 * second launch is not asked again. Never asked where those tools are denied
 * outright (review) or never ask (auto, bypass), nor for a background child
 * (its calls still prompt one by one).
 */
import { needsApproval, type CoworkMode } from '@/lib/coworkMode'

/** The tools that change things on the user's machine. */
export const EDITING_TOOLS = ['write', 'edit', 'bash', 'computer'] as const

const approved = new Map<string, Set<string>>()

/** The editing tools this child would be asked about, in `mode`. */
export function editingToolsAsked(mode: CoworkMode, tools: readonly string[]): string[] {
  return tools.filter((t) => (EDITING_TOOLS as readonly string[]).includes(t) && needsApproval(mode, t))
}

export type LaunchInfo = { agent: string; tools: string[]; model: string }

/**
 * Whether the launch may go ahead: true without asking when no question is due
 * or the definition was already approved in this session; otherwise `ask`'s answer.
 */
export async function checkLaunch(input: {
  sessionId: string
  agent: string
  mode: CoworkMode | undefined
  tools: readonly string[]
  model: string
  foreground: boolean
  ask: (info: LaunchInfo) => Promise<boolean>
}): Promise<boolean> {
  if (!input.foreground || !input.mode) return true
  const asked = editingToolsAsked(input.mode, input.tools)
  if (asked.length === 0) return true
  if (approved.get(input.sessionId)?.has(input.agent)) return true
  const yes = await input.ask({ agent: input.agent, tools: asked, model: input.model })
  if (yes) {
    const set = approved.get(input.sessionId) ?? new Set<string>()
    set.add(input.agent)
    approved.set(input.sessionId, set)
  }
  return yes
}

/** Forget a session's approvals (tests, and when a session is deleted). */
export function forgetLaunchApprovals(sessionId?: string): void {
  if (sessionId) approved.delete(sessionId)
  else approved.clear()
}
