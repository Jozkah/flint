import type { ToolResources } from '@janhq/tauri-plugin-agent-tools-api'
import {
  retryAgentToolUnsandboxed,
  withdrawAgentToolUnsandboxed,
} from '@/lib/agentTools'

/**
 * What the approval prompt says when a `bash` command failed only because
 * Windows' null device refuses sandboxed programs.
 */
export const NULL_DEVICE_RETRY_REASON =
  "This command needs to run outside the sandbox because Windows' null " +
  'device (NUL) refuses sandboxed programs. Allowing it runs this exact ' +
  'command once more, outside the sandbox, with your own permissions.'

/** Put in front of the output of a command that ran outside the sandbox. */
export const RAN_UNSANDBOXED_NOTE =
  '[The sandboxed run failed because Windows\' null device refuses sandboxed ' +
  'programs. The user allowed this command to run outside the sandbox; this ' +
  'is the result of that run.]\n'

/** Appended to the original failure when the user said no. */
export const RETRY_DECLINED_NOTE =
  '\n[The user did not allow this command to run outside the sandbox, so it ' +
  'failed as shown above. Do not retry it inside the sandbox. Continue ' +
  'without it, or tell the user what it was needed for.]'

/** Appended to the original failure when nothing could put the question. */
export const RETRY_UNAVAILABLE_NOTE =
  '\n[Running this command outside the sandbox could not be offered here. ' +
  'Do not retry it inside the sandbox. Tell the user it needs to run ' +
  "outside the sandbox because Windows' null device refuses sandboxed " +
  'programs.]'

/**
 * The sandboxed run an approved unsandboxed rerun replaced. Display-only: the
 * model gets the rerun's result, while the card keeps this collapsed under
 * "first attempt" so the user can still see what the sandbox did.
 */
export type FirstAttempt = {
  output: string
  isError: true
}

export type NullDeviceRetryOutcome = {
  output: string
  isError: boolean
  resources?: ToolResources
  /** Set only when the command actually ran again outside the sandbox. */
  firstAttempt?: FirstAttempt
}

/**
 * Offer to run a failed `bash` call outside the sandbox, and settle what the
 * model gets back.
 *
 * `ask` puts the question to the user and resolves whether they allowed it;
 * absent, nothing can present it and the failure stands with a note saying so.
 * A declined or unanswerable offer is withdrawn, so its id authorizes nothing
 * later. Never throws.
 */
export async function offerUnsandboxedRetry(opts: {
  threadId: string
  retry: string
  /** The sandboxed failure, as the model would otherwise have seen it. */
  failure: string
  failureResources?: ToolResources
  ask?: () => Promise<boolean>
}): Promise<NullDeviceRetryOutcome> {
  const { threadId, retry, failure, failureResources, ask } = opts
  let allowed = false
  if (ask) {
    try {
      allowed = await ask()
    } catch {
      allowed = false
    }
  }
  if (!allowed) {
    void withdrawAgentToolUnsandboxed(threadId, retry)
    return {
      output: failure + (ask ? RETRY_DECLINED_NOTE : RETRY_UNAVAILABLE_NOTE),
      isError: true,
      resources: failureResources,
    }
  }
  const rerun = await retryAgentToolUnsandboxed(threadId, retry)
  if (!rerun.ran) {
    return {
      output:
        failure +
        '\n[The user allowed running this command outside the sandbox, but it ' +
        `could not be started: ${rerun.error}. Do not retry it inside the ` +
        'sandbox.]',
      isError: true,
      resources: failureResources,
    }
  }
  const firstAttempt: FirstAttempt = { output: failure, isError: true }
  if (rerun.error !== undefined) {
    return {
      output: RAN_UNSANDBOXED_NOTE + rerun.error,
      isError: true,
      resources: rerun.resources,
      firstAttempt,
    }
  }
  return {
    output:
      RAN_UNSANDBOXED_NOTE +
      (typeof rerun.content === 'string'
        ? rerun.content
        : JSON.stringify(rerun.content ?? '')),
    isError: false,
    resources: rerun.resources,
    firstAttempt,
  }
}
