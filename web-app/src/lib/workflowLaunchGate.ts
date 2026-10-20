/**
 * Approval before a large `workflow` starts.
 *
 * A workflow of more than `WORKFLOW_APPROVAL_AGENTS` agents spends a lot of
 * model time at once, so the user sees its phases and agent count and says yes
 * once. Smaller runs, runs in modes that already decide for the user (Bypass),
 * and calls that are refused anyway (review mode, a subagent) are not asked.
 */
import type { PendingToolCall, ToolOutcome } from '@/lib/coworkRunner'
import { isReadOnly, type CoworkMode } from '@/lib/coworkMode'
import { WORKFLOW_TOOL_NAME } from '@/lib/workflowToolName'
import { DEFAULT_LOOP_ROUNDS, MAX_LOOP_ROUNDS, loopWorstCase } from '@/lib/workflowLoops'

/** Agents a workflow may run without asking. */
export const WORKFLOW_APPROVAL_AGENTS = 8

export type WorkflowGateContext = {
  mode: CoworkMode
  /** Absent for a subagent's dispatcher, which cannot start a workflow at all. */
  onTeam?: unknown
  onApprove?: (
    toolCallId: string,
    toolName: string,
    input: unknown,
    preview?: string,
    signal?: AbortSignal
  ) => Promise<boolean>
}

/** Agents per phase, in order, from a workflow call's input. */
export function phaseSizes(input: unknown): number[] {
  const phases = (input as { phases?: unknown } | null)?.phases
  if (!Array.isArray(phases)) return []
  return phases.map((phase) => {
    const agents = (phase as { agents?: unknown } | null)?.agents
    const count = Array.isArray(agents) ? agents.length : 0
    // A loop may start every round and every check: ask about the worst case.
    const loop = (phase as { repeat_until?: { max_rounds?: unknown } } | null)?.repeat_until
    if (!loop || typeof loop !== 'object') return count
    const rounds = Number.isInteger(loop.max_rounds) ? (loop.max_rounds as number) : DEFAULT_LOOP_ROUNDS
    return loopWorstCase(count, Math.min(Math.max(rounds, 1), MAX_LOOP_ROUNDS))
  })
}

/** An outcome to hand back when the call must not run, else `null`. */
export async function gateWorkflowLaunch(
  call: PendingToolCall,
  ctx: WorkflowGateContext,
  signal?: AbortSignal
): Promise<ToolOutcome | null> {
  if (ctx.mode === 'bypass' || isReadOnly(ctx.mode) || !ctx.onTeam) return null
  const total = phaseSizes(call.input).reduce((a, b) => a + b, 0)
  if (total <= WORKFLOW_APPROVAL_AGENTS) return null
  if (!ctx.onApprove) {
    return {
      output:
        `\`${WORKFLOW_TOOL_NAME}\` with ${total} agents needs the user's approval and nothing here can ask. ` +
        `Run at most ${WORKFLOW_APPROVAL_AGENTS} agents, or do the work yourself.`,
      isError: true,
    }
  }
  let allowed = false
  try {
    allowed = await ctx.onApprove(call.toolCallId, WORKFLOW_TOOL_NAME, call.input, undefined, signal)
  } catch {
    allowed = false
  }
  if (allowed && !signal?.aborted) return null
  return {
    output:
      `The user did not allow this ${total}-agent \`${WORKFLOW_TOOL_NAME}\`. Do not retry it unchanged. ` +
      'Offer a smaller one, or say what you would have run, and wait for instructions.',
    isError: true,
  }
}
