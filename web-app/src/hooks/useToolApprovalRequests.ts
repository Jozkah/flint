import { create } from 'zustand'
import { useToolApproval } from './useToolApproval'
import { getServiceHub } from '@/hooks/useServiceHub'
import { toast } from 'sonner'
import { errorText } from '@/lib/errorText'

export type PendingApproval = {
  toolCallId: string
  toolName: string
  threadId: string
  /** MCP server the tool belongs to, so the prompt can offer to trust it. */
  serverName?: string
  /** The diff a file-changing call would make, shown before it is allowed. */
  preview?: string
  /**
   * Who is asking, when it is not the conversation's own agent: a subagent or
   * a team child. Their calls are not parts of any message on screen, so the
   * prompt cannot sit under a tool card and is shown on its own instead.
   */
  origin?: string
  resolve: (approved: boolean) => void
}

/**
 * Scope of the grant. `allow-always` trusts the tool's whole server when it has
 * one, since trusting a server tool-by-tool is the same decision repeated.
 */
export type ApprovalDecision =
  | 'allow-once'
  | 'allow-thread'
  | 'allow-always'
  | 'deny'

type ToolApprovalRequestsState = {
  // In-flight per-tool-call approval prompts. Kept out of the persisted
  // useToolApproval store so approval churn never flushes to disk (the
  // resolve callbacks are non-serializable anyway).
  pending: Record<string, PendingApproval>
  /**
   * Requests waiting behind one already shown under the same call id.
   *
   * A call id is the model's, and it is only unique within one conversation:
   * a team's children are separate conversations, and a provider that numbers
   * calls per response gives each child's first call the same id. Keyed on the
   * id alone, a second request replaced the first, whose promise then never
   * resolved -- and that child waited forever with no prompt on screen. Each
   * is now shown in turn, in the order asked.
   */
  queued: Record<string, PendingApproval[]>

  requestApproval: (
    toolCallId: string,
    toolName: string,
    threadId: string,
    serverName?: string,
    preview?: string,
    origin?: string
  ) => Promise<boolean>
  resolveApproval: (toolCallId: string, decision: ApprovalDecision) => void
  clearPendingForThread: (threadId: string) => void
}

export const useToolApprovalRequests = create<ToolApprovalRequestsState>()(
  (set, get) => ({
    pending: {},
    queued: {},

    requestApproval: (
      toolCallId,
      toolName,
      threadId,
      serverName,
      preview,
      origin
    ) => {
      return new Promise<boolean>((resolve) => {
        const settings = useToolApproval.getState()
        if (settings.allowAllMCPPermissions) {
          resolve(true)
          return
        }
        if (settings.isToolApproved(threadId, toolName, serverName)) {
          resolve(true)
          return
        }
        const entry: PendingApproval = {
          toolCallId,
          toolName,
          threadId,
          serverName,
          preview,
          ...(origin ? { origin } : {}),
          resolve,
        }
        set((s) =>
          s.pending[toolCallId]
            ? {
                queued: {
                  ...s.queued,
                  [toolCallId]: [...(s.queued[toolCallId] ?? []), entry],
                },
              }
            : { pending: { ...s.pending, [toolCallId]: entry } }
        )
      })
    },

    resolveApproval: (toolCallId, decision) => {
      const entry = get().pending[toolCallId]
      if (!entry) return
      const approval = useToolApproval.getState()
      if (decision === 'allow-thread') {
        approval.approveToolForThread(entry.threadId, entry.toolName)
      } else if (decision === 'allow-always') {
        if (entry.serverName) {
          approval.approveServer(entry.serverName)
          // AH-041. The backend holds the record the gate reads, so an answer
          // that only updated renderer state would be forgotten by the thing
          // that enforces it. Failure is not swallowed silently: the user is
          // told, because otherwise the next call prompts again with no
          // explanation.
          void getServiceHub()
            .mcp()
            .trustServer(entry.serverName)
            .catch((error) => {
              toast.error('Could not remember that server', {
                description: errorText(error),
              })
            })
        } else {
          approval.approveToolEverywhere(entry.toolName)
        }
      }
      set((s) => {
        const next = { ...s.pending }
        const waiting = [...(s.queued[toolCallId] ?? [])]
        const promoted = waiting.shift()
        if (promoted) next[toolCallId] = promoted
        else delete next[toolCallId]
        const queued = { ...s.queued }
        if (waiting.length > 0) queued[toolCallId] = waiting
        else delete queued[toolCallId]
        return { pending: next, queued }
      })
      entry.resolve(decision !== 'deny')
    },

    clearPendingForThread: (threadId) => {
      const { pending, queued } = get()
      const stranded = [
        ...Object.values(pending),
        ...Object.values(queued).flat(),
      ].filter((entry) => entry.threadId === threadId)
      if (stranded.length === 0) return
      set((s) => {
        const next = { ...s.pending }
        for (const [id, entry] of Object.entries(next)) {
          if (entry.threadId === threadId) delete next[id]
        }
        const waiting: Record<string, PendingApproval[]> = {}
        for (const [id, list] of Object.entries(s.queued)) {
          const kept = list.filter((entry) => entry.threadId !== threadId)
          if (kept.length === 0) continue
          // Something still waiting for an id whose shown prompt was cleared
          // takes its place.
          if (!next[id]) next[id] = kept.shift()!
          if (kept.length > 0) waiting[id] = kept
        }
        return { pending: next, queued: waiting }
      })
      // Resolve as denied so any awaiting tool loop unblocks instead of hanging.
      for (const entry of stranded) entry.resolve(false)
    },
  })
)
