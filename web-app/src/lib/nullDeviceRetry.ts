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
 * The program a `bash` call runs (`go` for `go test ./...`), lowercased with
 * any directory and `.exe` dropped. Undefined when it cannot be told.
 */
export function commandProgram(input: unknown): string | undefined {
  const command =
    input && typeof input === 'object'
      ? (input as { command?: unknown }).command
      : undefined
  if (typeof command !== 'string') return undefined
  // Skip leading `VAR=value` assignments; take the first real word.
  const words = command.trim().split(/\s+/)
  const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  if (!first) return undefined
  const bare = first.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? ''
  const program = bare.toLowerCase().replace(/\.exe$/, '')
  return /^[a-z0-9._+-]+$/.test(program) ? program : undefined
}

/**
 * "Allow for this conversation" answers to an unsandboxed rerun, per thread
 * and program. Held in memory only: they end with the app session and are
 * never written to the standing grants.
 */
const conversationGrants = new Map<string, Set<string>>()

export function nullRerunAllowedForConversation(
  threadId: string,
  program: string | undefined
): boolean {
  return !!program && !!conversationGrants.get(threadId)?.has(program)
}

export function allowNullRerunForConversation(
  threadId: string,
  program: string
): void {
  let set = conversationGrants.get(threadId)
  if (!set) conversationGrants.set(threadId, (set = new Set()))
  set.add(program)
}

/** Test hook: forget every conversation grant. */
export function clearNullRerunGrants(): void {
  conversationGrants.clear()
}

/**
 * What an approval prompt for a rerun of `input` needs so it can offer "Allow
 * for this conversation" for its program, and record the answer here.
 */
export function nullRerunApprovalScope(
  threadId: string,
  input: unknown
): {
  conversationProgram?: string
  onDecision?: (decision: string) => void
} {
  const program = commandProgram(input)
  if (!program) return {}
  return {
    conversationProgram: program,
    onDecision: (decision) => {
      if (decision === 'allow-thread') {
        allowNullRerunForConversation(threadId, program)
      }
    },
  }
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
  /**
   * The program the command runs. When the user already allowed its reruns
   * for this conversation, the rerun goes ahead without asking.
   */
  program?: string
}): Promise<NullDeviceRetryOutcome> {
  const { threadId, retry, failure, failureResources, ask, program } = opts
  let allowed = false
  if (ask && nullRerunAllowedForConversation(threadId, program)) {
    allowed = true
  } else if (ask) {
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
