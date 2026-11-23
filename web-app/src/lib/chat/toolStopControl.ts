import { useAppState } from '@/hooks/useAppState'

/**
 * Chat shows its Stop button after the reply has finished only while a cancel
 * is registered for the thread (`cancelToolCalls`). MCP calls register one;
 * a Studio picture, which can take minutes, did not, so there was nothing to
 * press and Esc did nothing. Register `cancel` for the length of the call.
 * Other tools are left as they were.
 */
export async function withStudioStop<T>(
  threadId: string,
  toolName: string,
  cancel: () => void,
  run: () => Promise<T>
): Promise<T> {
  if (!toolName.startsWith('studio_')) return run()
  useAppState.getState().setThreadCancelToolCall(threadId, cancel)
  try {
    return await run()
  } finally {
    useAppState.getState().setThreadCancelToolCall(threadId, undefined)
  }
}
