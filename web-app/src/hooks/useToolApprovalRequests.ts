import { create } from 'zustand'
import { useToolApproval } from './useToolApproval'
import { getServiceHub } from '@/hooks/useServiceHub'
import { toast } from 'sonner'
import { errorText } from '@/lib/errorText'
import { resolveServerFingerprint } from '@/lib/mcpServerIdentity'
import { ALWAYS_ASK_TOOLS } from '@/lib/sessionMessagingTools'
import { isSelfApprovalTool } from '@/lib/selfApprovalTools'
import { destructiveCommandReason } from '@/lib/destructiveCommand'
import { GIT_TOOL_NAME, planGitTool } from '@/lib/gitTool'
import {
  autoApprovePauseReason,
  noteAutoApproved,
  resetAutoApproveStreak,
  useAutoApproveLimit,
} from '@/hooks/useAutoApproveLimit'
import { rememberCommand, repeatCommandKey } from '@/lib/repeatedCommand'

/**
 * What the prompt can say about a call beyond its name. All optional, so a
 * caller that only knows the name still gets a working prompt.
 */
export type ApprovalRequestContext = {
  /** The call's arguments, shown sanitized in the prompt. */
  input?: unknown
  /**
   * Ask even when a standing grant would answer: the call is destructive, or
   * the run has gone a long time without asking.
   */
  alwaysAsk?: boolean
  /** See `PermissionRequestInput.conversationProgram`. */
  conversationProgram?: string
  /** Told which answer the user gave, before the request resolves. */
  onDecision?: (decision: ApprovalDecision) => void
  /** Why the call is being made, only when the caller actually knows. */
  taskContext?: string
  /** Folder or project the call works in. */
  workspaceLabel?: string
  /**
   * The approved scope the destructive-command check compares paths against:
   * every folder the call may delete inside without being asked. Takes
   * precedence over `workspaceLabel`. Left out, the label is used when it is
   * an absolute path (a display label is ignored); otherwise the scope is
   * unknown (every absolute path counts as outside, so the call is asked about).
   */
  workspaceRoots?: readonly string[]
  /**
   * The caller already ran the destructive-command check itself -- through the
   * filesystem, with the real roots -- and reflected any finding in
   * `alwaysAsk` and `taskContext`. The text-only check here is then skipped,
   * so it cannot contradict the more accurate answer.
   */
  destructiveChecked?: boolean
  /**
   * Count a call a standing grant would answer toward the consecutive
   * auto-approval limit, under this key (the conversation). Past the limit
   * the call is put to the user instead; any prompt shown starts the count
   * over. Callers that count on their own (Cowork) leave it out.
   */
  autoApproveStreak?: string
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
  /**
   * Asked every time: no ordinary standing grant answers this prompt. The
   * temporary Git grant below is the one deliberate exception for ordinary
   * non-destructive remote Git/GitHub operations in this conversation.
   */
  alwaysAsk?: boolean
  conversationProgram?: string
  onDecision?: (decision: ApprovalDecision) => void
  /** When the prompt was raised (ms since epoch), to tell a long wait. */
  requestedAt?: number
  resolve: (approved: boolean) => void
}

/**
 * Scope of the grant. `allow-always` trusts the tool's whole server when it has
 * one, since trusting a server tool-by-tool is the same decision repeated.
 * `allow-git-temporary` is deliberately renderer-memory only and expires with
 * the app session; it never becomes a standing persisted grant.
 */
export type ApprovalDecision =
  | 'allow-once'
  | 'allow-thread'
  | 'allow-git-temporary'
  | 'allow-always'
  | 'deny'

/** Why a request that resolved `false` did so. */
export type ApprovalRefusal = 'denied' | 'cancelled'

/** Refusal reasons are kept for this many calls, newest last. */
const REFUSAL_MEMORY = 200

type ToolApprovalRequestsState = {
  pending: Record<string, PendingApproval>
  queued: Record<string, PendingApproval[]>
  refusals: Record<string, ApprovalRefusal>
  approvedFingerprints: Record<string, string>
  answeredByPrompt: Record<string, true>
  allowedOnceCommands: Record<string, string[]>
  temporaryGitThreads: Record<string, true>

  requestApproval: (
    toolCallId: string,
    toolName: string,
    threadId: string,
    serverName?: string,
    context?: ApprovalRequestContext
  ) => Promise<boolean>
  resolveApproval: (
    toolCallId: string,
    decision: ApprovalDecision,
    requestId?: string
  ) => void
  clearPendingForThread: (
    threadId: string,
    options?: { notify?: boolean }
  ) => void
  withdrawApproval: (requestId: string) => void
  takeRefusal: (toolCallId: string) => ApprovalRefusal | undefined
  takeApprovedFingerprint: (toolCallId: string) => string | undefined
}

function bashDestructiveReason(
  toolName: string,
  input: unknown,
  context: ApprovalRequestContext | undefined
): string | null {
  if (toolName !== 'bash') return null
  const command = (input as { command?: unknown } | undefined)?.command
  if (typeof command !== 'string') return null
  const label = context?.workspaceLabel
  const roots =
    context?.workspaceRoots ??
    (label && (/^[a-zA-Z]:[\\/]/.test(label) || label.startsWith('/'))
      ? [label]
      : [])
  return destructiveCommandReason(command, roots)
}

export function canTemporarilyAllowGit(
  toolName: string,
  input: unknown,
  threadIsEphemeral = false
): boolean {
  if (threadIsEphemeral || toolName !== GIT_TOOL_NAME) return false
  const planned = planGitTool(input)
  return (
    planned.ok &&
    planned.plan.class === 'remote' &&
    planned.plan.destructive === undefined
  )
}

let nextRequest = 0
const newRequestId = () => `req-${Date.now().toString(36)}-${++nextRequest}`

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
    answeredByPrompt: {},
    allowedOnceCommands: {},
    temporaryGitThreads: {},

    requestApproval: (toolCallId, toolName, threadId, serverName, context) => {
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
        if (serverName && serverFingerprint) {
          settings.noteServerFingerprint(serverName, serverFingerprint)
        }
        const destructive = context?.destructiveChecked
          ? null
          : bashDestructiveReason(toolName, context?.input, context)
        const selfApproval = !!serverName && isSelfApprovalTool(toolName)
        let alwaysAsk =
          ALWAYS_ASK_TOOLS.has(toolName) ||
          selfApproval ||
          context?.alwaysAsk === true ||
          destructive !== null
        let taskContext =
          context?.taskContext ??
          (destructive
            ? `Destructive command: ${destructive}. Asked even though this tool is otherwise allowed.`
            : selfApproval
              ? `${toolName} approves commands on ${serverName} itself. Only you can approve them, so it is asked about every time.`
              : undefined)

        const temporaryGitApproved =
          !!get().temporaryGitThreads[threadId] &&
          canTemporarilyAllowGit(
            toolName,
            context?.input,
            context?.threadIsEphemeral === true
          )
        if (temporaryGitApproved) {
          const streakKey = context?.autoApproveStreak
          if (streakKey === undefined) {
            approve()
            return
          }
          const limit = useAutoApproveLimit.getState().limit
          if (!noteAutoApproved(streakKey, limit)) {
            approve()
            return
          }
          alwaysAsk = true
          taskContext = autoApprovePauseReason(limit)
        }

        const streakKey = context?.autoApproveStreak
        if (!alwaysAsk && streakKey !== undefined) {
          const wouldAutoApprove =
            (serverName && settings.allowAllMCPPermissions) ||
            useToolApproval
              .getState()
              .isToolApproved(threadId, toolName, serverName, serverFingerprint)
          if (wouldAutoApprove) {
            const limit = useAutoApproveLimit.getState().limit
            if (noteAutoApproved(streakKey, limit)) {
              alwaysAsk = true
              taskContext = autoApprovePauseReason(limit)
            }
          }
        }
        if (!alwaysAsk && serverName && settings.allowAllMCPPermissions) {
          approve()
          return
        }
        if (
          !alwaysAsk &&
          useToolApproval
            .getState()
            .isToolApproved(threadId, toolName, serverName, serverFingerprint)
        ) {
          approve()
          return
        }
        if (streakKey !== undefined) resetAutoApproveStreak(streakKey)
        const entry: PendingApproval = {
          requestId: newRequestId(),
          toolCallId,
          toolName,
          threadId,
          serverName,
          ...(context?.preview !== undefined
            ? { preview: context.preview }
            : {}),
          ...(origin ? { origin } : {}),
          ...(serverFingerprint ? { serverFingerprint } : {}),
          ...(context?.input !== undefined ? { input: context.input } : {}),
          ...(taskContext ? { taskContext } : {}),
          ...(context?.workspaceLabel
            ? { workspaceLabel: context.workspaceLabel }
            : {}),
          ...(context?.threadIsEphemeral ? { threadIsEphemeral: true } : {}),
          ...(alwaysAsk ? { alwaysAsk: true } : {}),
          ...(context?.conversationProgram
            ? { conversationProgram: context.conversationProgram }
            : {}),
          ...(context?.onDecision ? { onDecision: context.onDecision } : {}),
          requestedAt: Date.now(),
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
      entry.onDecision?.(decision)
      const approval = useToolApproval.getState()
      const { serverName, serverFingerprint } = entry
      const temporaryGit =
        decision === 'allow-git-temporary' &&
        canTemporarilyAllowGit(
          entry.toolName,
          entry.input,
          entry.threadIsEphemeral === true
        )

      if (temporaryGit) {
        // Intentionally transient; persisted grants are not changed.
      } else if (
        ALWAYS_ASK_TOOLS.has(entry.toolName) ||
        (serverName && isSelfApprovalTool(entry.toolName)) ||
        entry.alwaysAsk
      ) {
        // Prompt-only request: no ordinary standing grant is recorded.
      } else if (decision === 'allow-thread') {
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
      } else if (decision === 'allow-always') {
        if (serverName) {
          if (serverFingerprint) {
            approval.approveServer(serverName, serverFingerprint)
          }
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
      const onceKey =
        decision === 'allow-once'
          ? repeatCommandKey(entry.toolName, entry.input)
          : null
      set((s) => ({
        ...without(s, entry),
        ...(temporaryGit
          ? {
              temporaryGitThreads: remember(s.temporaryGitThreads, [
                [entry.threadId, true as const],
              ]),
            }
          : {}),
        ...(onceKey
          ? {
              allowedOnceCommands: {
                ...s.allowedOnceCommands,
                [entry.threadId]: rememberCommand(
                  s.allowedOnceCommands[entry.threadId],
                  onceKey
                ),
              },
            }
          : {}),
        ...(decision === 'deny'
          ? { refusals: remember(s.refusals, [[toolCallId, 'denied']]) }
          : {
              answeredByPrompt: remember(s.answeredByPrompt, [
                [toolCallId, true as const],
              ]),
            }),
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

    clearPendingForThread: (threadId, options) => {
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
      for (const entry of stranded) entry.resolve(false)
      if (options?.notify) {
        const names = [...new Set(stranded.map((e) => e.toolName))].join(', ')
        toast.warning(
          stranded.length === 1
            ? `Approval for ${names} was cancelled`
            : `${stranded.length} approvals (${names}) were cancelled`,
          {
            description:
              'The chat was left before you answered. Send the request again to retry.',
          }
        )
      }
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

export function wasCommandAllowedOnce(
  state: Pick<ToolApprovalRequestsState, 'allowedOnceCommands'>,
  threadId: string,
  toolName: string,
  input: unknown
): boolean {
  const key = repeatCommandKey(toolName, input)
  return key !== null && !!state.allowedOnceCommands[threadId]?.includes(key)
}

export function approvalSourceFor(toolCallId: string): 'prompted' | 'auto' {
  return useToolApprovalRequests.getState().answeredByPrompt[toolCallId]
    ? 'prompted'
    : 'auto'
}
