/**
 * The two checks Chat puts in front of a tool call that would otherwise run
 * without asking -- the same two Cowork makes in `coworkDispatch.ts`:
 *
 * - a `bash` command that looks destructive is asked about, whatever allows
 *   it. Paths are judged against Chat's real scope, the thread's workspace,
 *   resolved and canonicalised by the desktop (`agent_destructive_reason`), so
 *   an absolute path inside the workspace is not asked about while a path
 *   outside it, through a link out of it, or that cannot be resolved is;
 * - after the configured number of consecutive unasked calls
 *   (`useAutoApproveLimit`, default 50, `0` off), the next one is asked
 *   about, and any prompt starts the count over.
 */

import { invoke } from '@tauri-apps/api/core'
import { threadWorkspacePath } from '@janhq/tauri-plugin-agent-tools-api'
import { getServiceHub } from '@/hooks/useServiceHub'
import { destructiveCommandReason } from '@/lib/destructiveCommand'
import {
  autoApprovePauseReason,
  noteAutoApproved,
  resetAutoApproveStreak,
  useAutoApproveLimit,
} from '@/hooks/useAutoApproveLimit'

/** Why a call that would run unasked must be put to the user instead. */
export type ChatForcedPrompt = { reason: string }

/**
 * The folders a Chat `bash` call may delete inside: the thread's workspace,
 * which is where Chat's shell runs. Empty when it cannot be resolved, which
 * makes the scope unknown and every absolute path outside -- asked about.
 */
export async function chatWorkspaceRoots(threadId: string): Promise<string[]> {
  try {
    const dataFolder = await getServiceHub().app().getJanDataFolder()
    if (!dataFolder) return []
    const root = await threadWorkspacePath(dataFolder, threadId)
    return root ? [root] : []
  } catch {
    return []
  }
}

/**
 * Why `command` would be asked about in `roots`. Resolved by the desktop
 * through the filesystem; when that is unreachable, the text-only check runs
 * against the same roots, which errs toward asking (it treats any `..` in an
 * absolute path as outside).
 */
export async function chatDestructiveReason(
  command: string,
  roots: readonly string[]
): Promise<string | null> {
  try {
    const reason = await invoke<string | null>('agent_destructive_reason', {
      command,
      roots,
    })
    return reason ?? null
  } catch {
    return destructiveCommandReason(command, roots)
  }
}

/**
 * Checks a Chat tool call that would run without a prompt. Returns why it must
 * be asked about instead, or null to let it run. A call that is let through
 * counts toward the consecutive-call limit; one that is asked about starts the
 * count over.
 */
export async function chatForcedPrompt(
  toolName: string,
  input: unknown,
  threadId: string
): Promise<ChatForcedPrompt | null> {
  const command =
    toolName === 'bash' &&
    typeof (input as { command?: unknown } | undefined)?.command === 'string'
      ? (input as { command: string }).command
      : undefined
  if (command !== undefined) {
    const destructive = await chatDestructiveReason(
      command,
      await chatWorkspaceRoots(threadId)
    )
    if (destructive) {
      resetAutoApproveStreak(threadId)
      return {
        reason: `Destructive command: ${destructive}. Asked even though this tool is otherwise allowed.`,
      }
    }
  }
  const limit = useAutoApproveLimit.getState().limit
  if (noteAutoApproved(threadId, limit)) {
    resetAutoApproveStreak(threadId)
    return { reason: autoApprovePauseReason(limit) }
  }
  return null
}
