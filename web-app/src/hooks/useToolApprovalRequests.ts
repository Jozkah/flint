import { create } from 'zustand'
import { useToolApproval } from './useToolApproval'
import { getServiceHub } from '@/hooks/useServiceHub'
import { toast } from 'sonner'
import { errorText } from '@/lib/errorText'
import { resolveServerFingerprint } from '@/lib/mcpServerIdentity'

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
  /**
   * The server's security fingerprint, when the caller already has it. `null`
   * means it was looked up and is unknown; left out, it is looked up here.
   */
  serverFingerprint?: string | null
}

export type PendingApproval = {
  toolCallId: string
  toolName: string
  threadId: string
  /** MCP server the tool belongs to, so the prompt can offer to trust it. */
  serverName?: string
  /**
   * The definition of `serverName` the user is being asked about. A grant
   * recorded from this prompt is bound to it.
   */
  serverFingerprint?: string
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
  /**
   * toolCallId -> the server fingerprint an approved MCP call was approved
   * for, so the one-time backend permission can be bound to the same
   * definition. Bounded; read with {@link takeApprovedFingerprint}.
   */
  approvedFingerprints: Record<string, string>

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
  /** The fingerprint this call was approved for, once. */
  takeApprovedFingerprint: (toolCallId: string) => string | undefined
}

function remember<T>(
  map: Record<string, T>,
  entries: [string, T][]
): Record<string, T> {
  const next = { ...map }
  for (const [id, value] of entries) {
    delete next[id]
    next[id] = value
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
    approvedFingerprints: {},

    requestApproval: (toolCallId, toolName, threadId, serverName, context) => {
      // An MCP call is approved for one definition of its server, so the
      // backend's fingerprint is needed before any grant can be checked.
      if (serverName && context?.serverFingerprint === undefined) {
        return resolveServerFingerprint(serverName).then((fingerprint) =>
          get().requestApproval(toolCallId, toolName, threadId, serverName, {
            ...context,
            serverFingerprint: fingerprint ?? null,
          })
        )
      }
      const serverFingerprint = context?.serverFingerprint ?? undefined

      return new Promise<boolean>((resolve) => {
        const settings = useToolApproval.getState()
        const approve = () => {
          if (serverName && serverFingerprint) {
            set((s) => ({
              approvedFingerprints: remember(s.approvedFingerprints, [
                [toolCallId, serverFingerprint],
              ]),
            }))
          }
          resolve(true)
        }
        // Grants recorded for an older definition of this server stop
        // applying now, and are listed as needing renewal.
        if (serverName && serverFingerprint) {
          settings.noteServerFingerprint(serverName, serverFingerprint)
        }
        // A standing grant answers without a prompt: allow-all, a server the
        // user trusts, the tool everywhere, or the tool in this thread.
        if (settings.allowAllMCPPermissions) {
          approve()
          return
        }
        if (
          useToolApproval
            .getState()
            .isToolApproved(threadId, toolName, serverName, serverFingerprint)
        ) {
          approve()
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
              ...(serverFingerprint ? { serverFingerprint } : {}),
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
      const { serverName, serverFingerprint } = entry
      if (decision === 'allow-thread') {
        if (!serverName) {
          approval.approveToolForThread(entry.threadId, entry.toolName)
        } else if (serverFingerprint) {
          approval.approveMcpToolForThread(
            entry.threadId,
            serverName,
            entry.toolName,
            serverFingerprint
          )
        }
        // A server tool whose definition is unknown is allowed this once and
        // nothing is recorded: a grant bound to no identity would match none.
      } else if (decision === 'allow-always') {
        if (serverName) {
          if (serverFingerprint) {
            approval.approveServer(serverName, serverFingerprint)
          }
          // AH-041. The backend holds the record the gate reads, so an answer
          // that only updated renderer state would be forgotten by the thing
          // that enforces it. It is bound to the definition the user was
          // shown; if the backend refuses (the server changed meanwhile), the
          // renderer grant is withdrawn too and the user is told.
          void getServiceHub()
            .mcp()
            .trustServer(serverName, serverFingerprint)
            .catch((error) => {
              useToolApproval.getState().revokeServer(serverName)
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
          ...(decision !== 'deny' && serverName && serverFingerprint
            ? {
                approvedFingerprints: remember(s.approvedFingerprints, [
                  [toolCallId, serverFingerprint],
                ]),
              }
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
            stranded.map(
              (entry) => [entry.toolCallId, 'cancelled'] as [string, ApprovalRefusal]
            )
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

    takeApprovedFingerprint: (toolCallId) => {
      const fingerprint = get().approvedFingerprints[toolCallId]
      if (fingerprint) {
        set((s) => {
          const next = { ...s.approvedFingerprints }
          delete next[toolCallId]
          return { approvedFingerprints: next }
        })
      }
      return fingerprint
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
