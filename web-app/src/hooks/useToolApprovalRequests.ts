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
  /** The diff a file-changing call would make, shown before it is allowed. */
  preview?: string
  /**
   * Who is asking, when it is not the conversation's own agent: a subagent or
   * a team child. Their calls are not parts of any message on screen, so the
   * prompt cannot sit under a tool card and is shown on its own instead.
   */
  origin?: string
  /**
   * The asking run's signal. When it aborts, the prompt is withdrawn -- taken
   * off screen, shown or queued -- and answered no, so a stopped run's
   * question cannot be answered afterwards.
   */
  signal?: AbortSignal
}

export type PendingApproval = {
  /**
   * This request, as distinct from any other under the same call id. An
   * answer names it, so a click meant for one request can never land on the
   * next one shown in its place.
   */
  requestId: string
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
  /**
   * Answer a request. With `requestId`, exactly that request is answered,
   * shown or still queued, and an answer for one already gone does nothing;
   * without it, the one shown under the call id.
   */
  resolveApproval: (
    toolCallId: string,
    decision: ApprovalDecision,
    requestId?: string
  ) => void
  clearPendingForThread: (threadId: string) => void
  /**
   * Take one request away unanswered, shown or queued, and answer it no. An
   * answer that arrives for it afterwards names a request that is gone.
   */
  withdrawApproval: (requestId: string) => void
  /** Why this call's request was refused, once; `undefined` if it was not. */
  takeRefusal: (toolCallId: string) => ApprovalRefusal | undefined
  /** The fingerprint this call was approved for, once. */
  takeApprovedFingerprint: (toolCallId: string) => string | undefined
}

let nextRequest = 0
const newRequestId = () => `req-${Date.now().toString(36)}-${++nextRequest}`

/** Every request waiting for an answer, shown or queued, in the order asked. */
export function allApprovalRequests(state: {
  pending: Record<string, PendingApproval>
  queued: Record<string, PendingApproval[]>
}): PendingApproval[] {
  const out: PendingApproval[] = []
  for (const [id, head] of Object.entries(state.pending)) {
    out.push(head, ...(state.queued[id] ?? []))
  }
  return out
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

/**
 * Take `entry` out of the shown/queued maps for its call id, promoting the
 * next one waiting under that id when `entry` was the one shown.
 */
function without(
  s: Pick<ToolApprovalRequestsState, 'pending' | 'queued'>,
  entry: PendingApproval
): Pick<ToolApprovalRequestsState, 'pending' | 'queued'> {
  const id = entry.toolCallId
  const next = { ...s.pending }
  const waiting = (s.queued[id] ?? []).filter((e) => e !== entry)
  if (next[id] === entry) {
    const promoted = waiting.shift()
    if (promoted) next[id] = promoted
    else delete next[id]
  }
  const queued = { ...s.queued }
  if (waiting.length > 0) queued[id] = waiting
  else delete queued[id]
  return { pending: next, queued }
}

export const useToolApprovalRequests = create<ToolApprovalRequestsState>()(
  (set, get) => ({
    pending: {},
    queued: {},
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
      const signal = context?.signal
      const origin = context?.origin

      return new Promise<boolean>((resolve) => {
        if (signal?.aborted) {
          set((s) => ({
            refusals: remember(s.refusals, [[toolCallId, 'cancelled']]),
          }))
          resolve(false)
          return
        }
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
        const entry: PendingApproval = {
          requestId: newRequestId(),
          toolCallId,
          toolName,
          threadId,
          serverName,
          ...(context?.preview !== undefined ? { preview: context.preview } : {}),
          ...(origin ? { origin } : {}),
          ...(serverFingerprint ? { serverFingerprint } : {}),
          ...(context?.input !== undefined ? { input: context.input } : {}),
          ...(context?.taskContext ? { taskContext: context.taskContext } : {}),
          ...(context?.workspaceLabel
            ? { workspaceLabel: context.workspaceLabel }
            : {}),
          ...(context?.threadIsEphemeral ? { threadIsEphemeral: true } : {}),
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
        signal?.addEventListener(
          'abort',
          () => get().withdrawApproval(entry.requestId),
          { once: true }
        )
      })
    },

    withdrawApproval: (requestId) => {
      const entry = allApprovalRequests(get()).find(
        (e) => e.requestId === requestId
      )
      if (!entry) return
      set((s) => ({
        ...without(s, entry),
        // Nobody said no: the run that asked stopped.
        refusals: remember(s.refusals, [[entry.toolCallId, 'cancelled']]),
      }))
      entry.resolve(false)
    },

    resolveApproval: (toolCallId, decision, requestId) => {
      const head = get().pending[toolCallId]
      const entry =
        requestId === undefined
          ? head
          : [head, ...(get().queued[toolCallId] ?? [])].find(
              (e) => e?.requestId === requestId
            )
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
      set((s) => ({
        ...without(s, entry),
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
      }))
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
        return {
          pending: next,
          queued: waiting,
          refusals: remember(
            s.refusals,
            stranded.map(
              (entry) =>
                [entry.toolCallId, 'cancelled'] as [string, ApprovalRefusal]
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

/**
 * Requests waiting on an answer, in one thread or everywhere. Queued ones
 * count: each will be shown and needs its own answer.
 */
export function selectPendingApprovalCount(
  state: Pick<ToolApprovalRequestsState, 'pending'> &
    Partial<Pick<ToolApprovalRequestsState, 'queued'>>,
  threadId?: string
): number {
  const entries = allApprovalRequests({
    pending: state.pending,
    queued: state.queued ?? {},
  })
  return threadId === undefined
    ? entries.length
    : entries.filter((entry) => entry.threadId === threadId).length
}

export function usePendingApprovalCount(threadId?: string): number {
  return useToolApprovalRequests((s) => selectPendingApprovalCount(s, threadId))
}
