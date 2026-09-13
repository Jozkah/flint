import { create } from 'zustand'
import { useToolApproval } from './useToolApproval'
import { getServiceHub } from '@/hooks/useServiceHub'
import { toast } from 'sonner'
import { errorText } from '@/lib/errorText'

/**
 * What the prompt can say about a call beyond its name. All optional, so a
 * caller that only knows the name still gets a working prompt.
 */
export type ApprovalRequestContext = {
  /** The call's arguments, shown sanitized in the prompt. */
  input?: unknown
  /** Why the call is being made, only when the caller actually knows. */
  taskContext?: string
  /** Folder or project the call works in. */
  workspaceLabel?: string
  /** The thread id is reused by the next conversation (temporary chat). */
  threadIsEphemeral?: boolean
}

export type PendingApproval = {
  toolCallId: string
  toolName: string
  threadId: string
  /** MCP server the tool belongs to, so the prompt can offer to trust it. */
  serverName?: string
  input?: unknown
  taskContext?: string
  workspaceLabel?: string
  threadIsEphemeral?: boolean
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

/** Why a request that resolved `false` did so. */
export type ApprovalRefusal = 'denied' | 'cancelled'

/** Refusal reasons are kept for this many calls, newest last. */
const REFUSAL_MEMORY = 200

type ToolApprovalRequestsState = {
  // In-flight per-tool-call approval prompts. Kept out of the persisted
  // useToolApproval store so approval churn never flushes to disk (the
  // resolve callbacks are non-serializable anyway).
  pending: Record<string, PendingApproval>
  /**
   * toolCallId -> why its request resolved `false`. Lets the caller record
   * "cancelled because the conversation stopped" rather than "denied" for a
   * prompt nobody answered. Bounded; read with {@link takeRefusal}.
   */
  refusals: Record<string, ApprovalRefusal>

  requestApproval: (
    toolCallId: string,
    toolName: string,
    threadId: string,
    serverName?: string,
    context?: ApprovalRequestContext
  ) => Promise<boolean>
  resolveApproval: (toolCallId: string, decision: ApprovalDecision) => void
  clearPendingForThread: (threadId: string) => void
  /** Why this call's request was refused, once; `undefined` if it was not. */
  takeRefusal: (toolCallId: string) => ApprovalRefusal | undefined
}

function remember(
  refusals: Record<string, ApprovalRefusal>,
  entries: [string, ApprovalRefusal][]
): Record<string, ApprovalRefusal> {
  const next = { ...refusals }
  for (const [id, why] of entries) {
    delete next[id]
    next[id] = why
  }
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - REFUSAL_MEMORY))) {
    delete next[key]
  }
  return next
}

export const useToolApprovalRequests = create<ToolApprovalRequestsState>()(
  (set, get) => ({
    pending: {},
    refusals: {},

    requestApproval: (toolCallId, toolName, threadId, serverName, context) => {
      return new Promise<boolean>((resolve) => {
        const settings = useToolApproval.getState()
        // A standing grant answers without a prompt: allow-all, a server the
        // user trusts, the tool everywhere, or the tool in this thread.
        if (settings.allowAllMCPPermissions) {
          resolve(true)
          return
        }
        if (settings.isToolApproved(threadId, toolName, serverName)) {
          resolve(true)
          return
        }
        set((s) => ({
          pending: {
            ...s.pending,
            [toolCallId]: {
              toolCallId,
              toolName,
              threadId,
              serverName,
              ...(context?.input !== undefined ? { input: context.input } : {}),
              ...(context?.taskContext
                ? { taskContext: context.taskContext }
                : {}),
              ...(context?.workspaceLabel
                ? { workspaceLabel: context.workspaceLabel }
                : {}),
              ...(context?.threadIsEphemeral ? { threadIsEphemeral: true } : {}),
              resolve,
            },
          },
        }))
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
        delete next[toolCallId]
        return {
          pending: next,
          ...(decision === 'deny'
            ? { refusals: remember(s.refusals, [[toolCallId, 'denied']]) }
            : {}),
        }
      })
      entry.resolve(decision !== 'deny')
    },

    clearPendingForThread: (threadId) => {
      const { pending } = get()
      const stranded = Object.values(pending).filter(
        (entry) => entry.threadId === threadId
      )
      if (stranded.length === 0) return
      set((s) => {
        const next = { ...s.pending }
        for (const entry of stranded) delete next[entry.toolCallId]
        return {
          pending: next,
          refusals: remember(
            s.refusals,
            stranded.map((entry) => [entry.toolCallId, 'cancelled'])
          ),
        }
      })
      // Resolve as denied so any awaiting tool loop unblocks instead of hanging.
      for (const entry of stranded) entry.resolve(false)
    },

    takeRefusal: (toolCallId) => {
      const why = get().refusals[toolCallId]
      if (why) {
        set((s) => {
          const next = { ...s.refusals }
          delete next[toolCallId]
          return { refusals: next }
        })
      }
      return why
    },
  })
)

/** Requests waiting on an answer, in one thread or everywhere. */
export function selectPendingApprovalCount(
  state: Pick<ToolApprovalRequestsState, 'pending'>,
  threadId?: string
): number {
  const entries = Object.values(state.pending)
  return threadId === undefined
    ? entries.length
    : entries.filter((entry) => entry.threadId === threadId).length
}

export function usePendingApprovalCount(threadId?: string): number {
  return useToolApprovalRequests((s) => selectPendingApprovalCount(s, threadId))
}
