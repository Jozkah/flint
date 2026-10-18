/**
 * An MCP tool call that Stop reaches at the server.
 *
 * Without a cancellation token the backend only tells the server to give up
 * (`notifications/cancelled`) when its own per-server timeout fires, so a
 * stopped turn left the call pending at the server until then (M-011). With
 * one, aborting `signal` cancels the call at once.
 */
import type { MCPService } from '@/services/mcp/types'

type CallArgs = Parameters<MCPService['callTool']>[0]

export function newToolCallToken(): string {
  return `tool_call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

export async function callMcpToolCancellable(
  mcp: Pick<MCPService, 'callTool' | 'cancelToolCall'>,
  args: Omit<CallArgs, 'cancellationToken'>,
  signal?: AbortSignal
): ReturnType<MCPService['callTool']> {
  const token = newToolCallToken()
  const cancel = () => {
    void mcp.cancelToolCall(token).catch(() => {})
  }
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await mcp.callTool({ ...args, cancellationToken: token })
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
