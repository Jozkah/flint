/**
 * The approval side of `stop_session` (docs/SESSION_MESSAGING.md).
 *
 * Runs in the calling session's dispatcher before the backend tool is invoked.
 * Every call is put to that session's user -- in every mode that offers the
 * tool, and whatever standing grants exist (see `ALWAYS_ASK_TOOLS`) -- and only
 * a yes is recorded with the backend, bound to this call id, the target and
 * the reason. The backend tool refuses a call that has no such record, so the
 * prompt cannot be skipped by reaching the tool some other way.
 */
import type { PendingToolCall, ToolOutcome } from '@/lib/coworkRunner'
import { isReadOnly, type CoworkMode } from '@/lib/coworkMode'
import {
  sessionMailbox,
  toMailboxError,
  type SessionMailbox,
} from '@/lib/sessionMailbox'
import {
  MAX_STOP_REASON_CHARS,
  STOP_SESSION_TOOL_NAME,
} from '@/lib/sessionMessagingTools'
import {
  recordToolActivity,
  type ToolActivityContext,
} from '@/lib/toolActivity'

export type StopGateContext = {
  sessionId: string
  mode: CoworkMode
  activity?: Partial<ToolActivityContext>
  /** Absent for a caller that cannot show a prompt (a subagent): refused. */
  onApprove?: (
    toolCallId: string,
    toolName: string,
    input: unknown,
    preview?: string,
    signal?: AbortSignal
  ) => Promise<boolean>
}

type GateMailbox = Pick<SessionMailbox, 'listSessions' | 'approveStop'>

const toolError = (code: string, message: string): ToolOutcome => ({
  output: `ERROR: ${JSON.stringify({ error: { code, message } })}`,
  isError: true,
})

function unlessStopped(
  answer: Promise<boolean>,
  signal?: AbortSignal
): Promise<boolean> {
  if (!signal) return answer
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve, reject) => {
    const stop = () => resolve(false)
    signal.addEventListener('abort', stop, { once: true })
    answer.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      }
    )
  })
}

/**
 * Returns the outcome to hand back when the call must not proceed, or `null`
 * once the user approved and the approval is recorded.
 */
export async function gateStopSession(
  call: PendingToolCall,
  ctx: StopGateContext,
  signal?: AbortSignal,
  mailbox: GateMailbox = sessionMailbox
): Promise<ToolOutcome | null> {
  if (isReadOnly(ctx.mode)) {
    return {
      output:
        'The `stop_session` tool is disabled in review mode, which changes ' +
        'nothing. Use send_message to ask the other session instead.',
      isError: true,
    }
  }
  if (!ctx.onApprove && ctx.mode !== 'bypass') {
    return toolError(
      'not_available',
      'stop_session needs the approval of the user of a Cowork session, and nothing here can ask for it.'
    )
  }
  const input = (call.input ?? {}) as Record<string, unknown>
  const target = typeof input.session_id === 'string' ? input.session_id.trim() : ''
  const reason = typeof input.reason === 'string' ? input.reason : ''
  if (!target) {
    return toolError(
      'invalid_arguments',
      'stop_session needs string `session_id` and `reason`'
    )
  }
  if (!reason.trim() || [...reason].length > MAX_STOP_REASON_CHARS) {
    return toolError(
      'invalid_reason',
      `reason must be 1..=${MAX_STOP_REASON_CHARS} characters and not blank`
    )
  }
  if (target === ctx.sessionId) {
    return toolError('self_target', 'a session cannot stop itself with this tool')
  }

  let peers
  try {
    peers = await mailbox.listSessions(ctx.sessionId)
  } catch (e) {
    const err = toMailboxError(e)
    return toolError(err.code, err.message)
  }
  // Only sessions in this session's project are listed, so a session in
  // another project is refused exactly like one that does not exist.
  const peer = peers.find((one) => one.id === target)
  if (!peer) {
    return toolError('unknown_session', 'no session with that id in this project')
  }
  if (peer.status !== 'running') {
    return toolError(
      'target_not_running',
      'that session is not running, so there is nothing to stop'
    )
  }

  const permission = {
    call: call.toolCallId,
    tool: STOP_SESSION_TOOL_NAME,
    session: ctx.sessionId,
    run: ctx.activity?.run ?? '',
    invocation: ctx.activity?.invocation ?? '',
    agent: ctx.activity?.agent ?? '',
    resource: `session:${peer.id}`,
  }
  if (ctx.mode !== 'bypass') {
    await recordToolActivity({ ...permission, phase: 'awaiting-permission' })
  }
  let allowed = false
  try {
    allowed = ctx.mode === 'bypass' || await unlessStopped(
      ctx.onApprove!(
        call.toolCallId,
        STOP_SESSION_TOOL_NAME,
        // What the prompt names: the session by its title, and the reason.
        { session: peer.displayName, session_id: peer.id, reason },
        undefined,
        signal
      ),
      signal
    )
  } catch {
    allowed = false
  }
  if (signal?.aborted) {
    await recordToolActivity({
      ...permission,
      phase: 'cancelled',
      detail: 'approval withdrawn: run stopped',
    })
    return {
      output:
        '`stop_session` was not run: this run was stopped while it waited for approval.',
      isError: true,
    }
  }
  await recordToolActivity({
    ...permission,
    phase: allowed ? 'allowed' : 'refused',
  })
  if (!allowed) {
    return {
      output:
        'The user did not allow stopping that session. Do not retry it. ' +
        'Use send_message to coordinate, or wait for instructions.',
      isError: true,
    }
  }
  try {
    await mailbox.approveStop({
      sessionId: ctx.sessionId,
      callId: call.toolCallId,
      targetSessionId: peer.id,
      reason,
    })
  } catch (e) {
    const err = toMailboxError(e)
    return toolError(err.code, err.message)
  }
  return null
}
