/**
 * Pause, resume and restart-one-agent for a running `workflow`, as a tool
 * operation. Reuses the run's `TeamControl` (AH-111), the same handle the Tasks
 * panel buttons press; there is no second mechanism.
 */
import type { ToolOutcome } from '@/lib/coworkRunner'
import { useTeamControls } from '@/hooks/useTeamControls'
import type { TeamControl, ControlRequest } from '@/lib/coworkTeamControl'

export const WORKFLOW_CONTROL_ACTIONS = ['pause', 'resume', 'restart'] as const
export type WorkflowControlAction = (typeof WORKFLOW_CONTROL_ACTIONS)[number]

/**
 * The live control of the run a background workflow's `task_id` names, in this
 * session. Team task ids are `session|run|callId`, and a call id is the
 * `task_id` the model was given.
 */
export function controlForRun(sessionId: string | undefined, runId: string): TeamControl | undefined {
  if (!sessionId || !runId) return undefined
  const controls = useTeamControls.getState().controls
  const key = Object.keys(controls).find(
    (one) => one.startsWith(`${sessionId}|`) && one.endsWith(`|${runId}`)
  )
  const control = key ? controls[key] : undefined
  return control && !control.finished ? control : undefined
}

/** Handle `{ control: { run_id, action, agent_id? } }` on a `workflow` call. */
export function runWorkflowControl(sessionId: string | undefined, raw: unknown): ToolOutcome {
  const one = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const runId = typeof one.run_id === 'string' ? one.run_id.trim() : ''
  const action = one.action
  const agent = typeof one.agent_id === 'string' ? one.agent_id.trim() : ''
  if (!runId) return { output: 'ERROR: `control.run_id` is the task_id of a running workflow', isError: true }
  if (!(WORKFLOW_CONTROL_ACTIONS as readonly unknown[]).includes(action)) {
    return {
      output: `ERROR: \`control.action\` must be one of ${WORKFLOW_CONTROL_ACTIONS.join(', ')}`,
      isError: true,
    }
  }
  if (action === 'restart' && !agent) {
    return { output: 'ERROR: `control.agent_id` names the agent to restart', isError: true }
  }
  const control = controlForRun(sessionId, runId)
  if (!control) {
    return {
      output: `ERROR: no running workflow with task_id ${runId} (it may have finished; start it again, or resume it with resume_run_id)`,
      isError: true,
    }
  }
  const request: ControlRequest =
    action === 'restart' ? { kind: 'restart', taskId: agent } : { kind: action as 'pause' | 'resume' }
  control.request(request)
  return {
    output:
      action === 'pause'
        ? 'Paused: agents already running will finish, no new agent starts until resume.'
        : action === 'resume'
          ? 'Resumed.'
          : `Restart of agent ${agent} requested.`,
  }
}
