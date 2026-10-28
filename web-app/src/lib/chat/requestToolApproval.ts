import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { serverForTool } from '@/lib/chat/threadHelpers'

/*
 * The approval prompts a Chat tool call can raise. They were written out four
 * times in ThreadConversation.tsx with the same fields; the variants are kept
 * apart here by name so a call site says which one it wants.
 */

type CallRef = { toolCallId: string; toolName: string; input: unknown }
type RequestOptions = NonNullable<
  Parameters<ReturnType<typeof useToolApprovalRequests.getState>['requestApproval']>[4]
>

/**
 * The ordinary prompt: remembered grants and the auto-approve streak apply,
 * and an MCP tool offers to trust its whole server.
 */
export function requestToolApproval(
  call: CallRef,
  threadId: string
): Promise<boolean> {
  return useToolApprovalRequests
    .getState()
    .requestApproval(
      call.toolCallId,
      call.toolName,
      threadId,
      serverForTool(call.toolName),
      {
        input: call.input,
        threadIsEphemeral: threadId === TEMPORARY_CHAT_ID,
        autoApproveStreak: threadId,
      }
    )
}

/**
 * A prompt that is asked every time, whatever was granted before: a command
 * the run itself flagged. The destructive check has already been made
 * through the filesystem with the thread's real workspace.
 */
export function requestAlwaysAskApproval(
  call: CallRef,
  threadId: string,
  opts: {
    taskContext: string
    signal?: AbortSignal
    /** Extra fields that scope what an approval would cover. */
    scope?: Partial<RequestOptions>
  }
): Promise<boolean> {
  return useToolApprovalRequests
    .getState()
    .requestApproval(call.toolCallId, call.toolName, threadId, undefined, {
      input: call.input,
      alwaysAsk: true,
      taskContext: opts.taskContext,
      ...opts.scope,
      destructiveChecked: true,
      threadIsEphemeral: threadId === TEMPORARY_CHAT_ID,
      signal: opts.signal,
    })
}
