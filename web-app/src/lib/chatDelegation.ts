/**
 * Delegation in plain desktop chat.
 *
 * A conversation that has the built-in agent tools on can hand a job to a
 * subagent with `task`, start several with `background: true`, and collect
 * them with `await_task`. It is the Cowork tool family on the chat's own
 * footing (see `surfaceDelegation`): the children's calls are gated in Ask mode,
 * the attached folders stay read-only, and the children's rows appear in the
 * Tasks panel the conversation can open.
 *
 * Gated by a setting that is on by default and only matters when the agent
 * tools are on: there is nothing for a child to do otherwise.
 */
import type { Tool } from 'ai'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { useChatSessions } from '@/stores/chat-session-store'
import { useThreads } from '@/hooks/useThreads'
import { chatFoldersOf } from '@/lib/chatFolders'
import { chatRunOf } from '@/lib/chatRun'
import { type PendingToolCall, type ToolOutcome } from '@/lib/coworkRunner'
import { listSubagents } from '@/lib/coworkSubagentRegistry'
import { delegationTools } from '@/lib/coworkTools'
import {
  createSurfaceDelegation,
  type SurfaceDelegation,
} from '@/lib/surfaceDelegation'

export { SURFACE_DELEGATION_TOOL_NAMES as CHAT_DELEGATION_TOOL_NAMES } from '@/lib/surfaceDelegation'

/** Whether a chat offers delegation: the agent tools are on and so is this. */
export function chatDelegationEnabled(): boolean {
  const config = useAgentToolsConfig.getState()
  return config.agentToolsEnabled && config.chatDelegationEnabled
}

/** The tool definitions a chat advertises. Names are the saved subagents. */
export async function chatDelegationTools(): Promise<{
  tools: Record<string, Tool>
  names: string[]
}> {
  if (!chatDelegationEnabled()) return { tools: {}, names: [] }
  const names = (await listSubagents()).map((d) => d.name)
  return {
    tools: delegationTools(names, { team: false, isolate: false, background: true }),
    names,
  }
}

type Held = {
  delegation: SurfaceDelegation
  controller: AbortController
}
const held = new Map<string, Held>()

async function delegationOf(threadId: string, modelId: string): Promise<Held | null> {
  const existing = held.get(threadId)
  if (existing && !existing.controller.signal.aborted) return existing
  const transport = useChatSessions.getState().sessions[threadId]?.transport
  if (!transport) return null
  const controller = new AbortController()
  const thread = useThreads.getState().threads[threadId]
  const delegation = await createSurfaceDelegation({
    id: threadId,
    runId: () => chatRunOf(threadId)?.run || `chat:${threadId}`,
    title: thread?.title || 'This conversation',
    folders: chatFoldersOf(thread),
    model: () => transport.model,
    modelId,
    providerOptions: () => transport.reasoningProviderOptions(threadId),
    signal: controller.signal,
    background: true,
    scope: 'thread',
  })
  const next = { delegation, controller }
  held.set(threadId, next)
  return next
}

/**
 * Run one delegation tool call for a chat. Always resolves: a failure comes
 * back as an error outcome the model can read.
 */
export async function runChatDelegation(
  threadId: string,
  modelId: string,
  call: PendingToolCall,
  signal?: AbortSignal
): Promise<ToolOutcome> {
  try {
    const entry = await delegationOf(threadId, modelId)
    if (!entry) {
      return {
        output: 'ERROR: delegation is not available in this conversation right now.',
        isError: true,
      }
    }
    return await entry.delegation.run(call, signal)
  } catch (error) {
    return {
      output: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    }
  }
}

/** Stop every child a conversation started, and forget its delegation. */
export function stopChatDelegation(threadId: string): void {
  const entry = held.get(threadId)
  if (!entry) return
  entry.controller.abort('cancelled')
  held.delete(threadId)
}

/** Whether the conversation has children still running. */
export function chatHasRunningChildren(threadId: string): boolean {
  return (held.get(threadId)?.delegation.tasks.running().length ?? 0) > 0
}
