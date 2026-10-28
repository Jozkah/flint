import { useAppState } from '@/hooks/useAppState'
import { useMessages } from '@/hooks/useMessages'
import { OUT_OF_CONTEXT_SIZE } from '@/utils/error'
import { CHAT_DELEGATION_TOOL_NAMES } from '@/lib/chatDelegation'
import { isNativeWebToolInRun } from '@/lib/webSearchTool'
import { isImageTool } from '@/lib/chatImageTools'
import { AGENT_TOOL_NAMES } from '@/lib/agentTools'
import { isVisualizeTool } from '@/lib/visualize/constants'
import { isChatReadTool } from '@/lib/chatReadTool'

/*
 * Small helpers of the Chat conversation that need no component state: they
 * read the stores directly or take plain arguments. Lifted out of
 * ThreadConversation.tsx so they can be tested, and so the next steps of its
 * split have somewhere to share them from.
 */

// The MCP server a tool belongs to, so an approval prompt can offer to trust
// the whole server rather than this one tool.
export function serverForTool(toolName: string): string | undefined {
  return useAppState.getState().tools.find((tool) => tool.name === toolName)
    ?.server
}

// Internal tools never prompt: RAG and the native web tools are Flint's own, and
// the built-in agent tools are gated in Rust (execute_tool refuses anything
// needing approval), so only workspace-confined calls ever reach here.
// `threadId` ties the web tool check to the tool set that thread's run was sent
// with rather than the global setting, which may have changed mid-run.
export function isAutoAllowedTool(toolName: string, threadId?: string): boolean {
  return (
    useAppState.getState().ragToolNames.has(toolName) ||
    isNativeWebToolInRun(toolName, threadId) ||
    isVisualizeTool(toolName) ||
    // Reads only conversations the user mentioned, from local stores.
    isChatReadTool(toolName) ||
    isImageTool(toolName) ||
    AGENT_TOOL_NAMES.has(toolName) ||
    // Handing a job to a subagent asks for nothing itself; what the child then
    // does is gated call by call, in Ask mode.
    CHAT_DELEGATION_TOOL_NAMES.has(toolName)
  )
}

// Persist the out-of-context error onto the latest user message so the banner
// survives thread switches, mirroring how LlamacppOomListener stamps oom/backend.
export function stampContextErrorOnThread(
  threadId: string,
  message: string = OUT_OF_CONTEXT_SIZE
) {
  const messages = useMessages.getState().getMessages(threadId)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const meta = (m.metadata as Record<string, unknown> | undefined) ?? {}
    if (typeof meta.contextError === 'string') return
    useMessages.getState().updateMessage({
      ...m,
      metadata: { ...meta, contextError: message },
    })
    return
  }
}

/** Where the Details inspector's open state is remembered. */
export const DETAILS_OPEN_KEY = 'flint.chat.detailsOpen'

export function readDetailsOpen(isSplit: boolean): boolean {
  if (isSplit) return false
  try {
    const saved = localStorage.getItem(DETAILS_OPEN_KEY)
    if (saved !== null) return saved === 'true'
  } catch {
    // Storage unavailable: fall back to the window size.
  }
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(min-width: 1280px)').matches
  )
}

export function writeDetailsOpen(open: boolean) {
  try {
    localStorage.setItem(DETAILS_OPEN_KEY, String(open))
  } catch {
    // Not remembered; the default applies next time.
  }
}
