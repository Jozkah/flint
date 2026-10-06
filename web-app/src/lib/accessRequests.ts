import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import type { WorkspaceScope } from '@janhq/tauri-plugin-agent-tools-api'
import { useToolApproval } from '@/hooks/useToolApproval'

/**
 * `request_access`: the model asks for one folder or file outside its
 * workspace, and the user answers.
 *
 * The backend owns every decision about what a path means. `access_prepare`
 * canonicalizes the request (resolving `..`, links and junctions) and refuses
 * anything that must never be granted by a one-line prompt -- a drive root,
 * the home directory, `.ssh`, a browser profile, Flint's own data folder -- so
 * the prompt shows exactly the scope a grant would enforce. `access_grant`
 * vets it again, so an approval can never cover more than was shown.
 *
 * Nothing here is remembered as a standing approval of the tool itself: every
 * request is its own prompt, and a "no" is answered to the model as a
 * structured denial it can act on rather than a failure it retries.
 */

export type AccessMode = 'read' | 'write'

/** What the prompt shows: the resolved scope, never the model's spelling alone. */
export type PreparedAccess = {
  status: 'ok'
  display: string
  isDir: boolean
  mode: AccessMode
  requested: string
  resolvedDiffers: boolean
}

export type RefusedAccess = {
  status: 'refused'
  code: string
  message: string
  /** What the tool call returns to the model. */
  modelResult: string
}

export type AccessGrant = {
  id: string
  session: string
  path: string
  display: string
  isDir: boolean
  mode: AccessMode
  reason: string
  grantedAt: number
  expiresAt: number | null
  persistent: boolean
}

const PLUGIN = 'plugin:agent-tools|'

/**
 * Who asked, for the audit record: the run and tool call a `request_access`
 * came from, the agent, and the project the session is bound to. Without
 * them the record had empty ids, unlike every other permission decision.
 */
export type AccessAuditIds = {
  run?: string
  call?: string
  agent?: string
  project?: string
}

export const prepareAccess = (args: {
  dataFolder: string
  sessionId: string
  path: string
  accessMode: AccessMode
  reason: string
  scope?: WorkspaceScope
  audit?: AccessAuditIds
}) => invoke<PreparedAccess | RefusedAccess>(`${PLUGIN}access_prepare`, args)

export const grantAccess = (args: {
  dataFolder: string
  sessionId: string
  path: string
  accessMode: AccessMode
  reason: string
  persistent: boolean
  scope?: WorkspaceScope
  audit?: AccessAuditIds
}) => invoke<AccessGrant>(`${PLUGIN}access_grant`, args)

export const recordAccessDecision = (args: {
  dataFolder: string
  sessionId: string
  path: string
  accessMode: AccessMode
  decision: 'denied' | 'cancelled'
  audit?: AccessAuditIds
}) => invoke<void>(`${PLUGIN}access_record_decision`, args)

export const revokeAccess = (dataFolder: string, grantId: string) =>
  invoke<boolean>(`${PLUGIN}access_revoke`, { dataFolder, grantId })

export const listAccessGrants = (dataFolder: string, sessionId?: string) =>
  invoke<AccessGrant[]>(`${PLUGIN}access_list`, { dataFolder, sessionId })

/** How the user answered. `session` expires with the session; `always` is kept. */
export type AccessDecision = 'session' | 'always' | 'deny'

/**
 * How long a request waits for an answer before it is treated as declined.
 * A run once sat behind an unanswered prompt for over ten minutes; past this
 * the model is told to carry on without the access instead.
 */
export const ACCESS_REQUEST_TIMEOUT_MS = 10 * 60 * 1000

export type PendingAccessRequest = {
  id: string
  threadId: string
  /** Title of the conversation asking, so the user knows which task it is. */
  taskLabel?: string
  /** A subagent or team child, when it is not the conversation's own agent. */
  origin?: string
  reason: string
  prepared: PreparedAccess
  resolve: (decision: AccessDecision | 'cancelled' | 'timed-out') => void
}

type AccessRequestsState = {
  /** Oldest first. Only the head is shown; the rest wait their turn. */
  queue: PendingAccessRequest[]
  /**
   * How many prompt surfaces are mounted. With none, nobody can answer, and a
   * request is answered `unavailable` at once instead of waiting forever.
   */
  presenters: number
  ask: (
    request: Omit<PendingAccessRequest, 'id' | 'resolve'>,
    signal?: AbortSignal
  ) => Promise<AccessDecision | 'cancelled' | 'unavailable' | 'timed-out'>
  answer: (id: string, decision: AccessDecision) => void
  withdraw: (id: string) => void
  withdrawThread: (threadId: string) => void
  attachPresenter: () => () => void
}

let nextId = 0

export const useAccessRequests = create<AccessRequestsState>()((set, get) => ({
  queue: [],
  presenters: 0,

  ask: (request, signal) => {
    if (get().presenters === 0) return Promise.resolve('unavailable' as const)
    if (signal?.aborted) return Promise.resolve('cancelled' as const)
    return new Promise((settle) => {
      const id = `access-${Date.now().toString(36)}-${++nextId}`
      // Unanswered for too long: taken off the queue and answered as timed
      // out. Cleared by whichever answer comes first.
      const timer = setTimeout(() => {
        if (!get().queue.some((e) => e.id === id)) return
        set((s) => ({ queue: s.queue.filter((e) => e.id !== id) }))
        settle('timed-out')
      }, ACCESS_REQUEST_TIMEOUT_MS)
      const resolve: PendingAccessRequest['resolve'] = (decision) => {
        clearTimeout(timer)
        settle(decision)
      }
      const entry: PendingAccessRequest = { ...request, id, resolve }
      set((s) => ({ queue: [...s.queue, entry] }))
      signal?.addEventListener('abort', () => get().withdraw(id), {
        once: true,
      })
    })
  },

  answer: (id, decision) => {
    const entry = get().queue.find((e) => e.id === id)
    if (!entry) return
    set((s) => ({ queue: s.queue.filter((e) => e.id !== id) }))
    entry.resolve(decision)
  },

  withdraw: (id) => {
    const entry = get().queue.find((e) => e.id === id)
    if (!entry) return
    set((s) => ({ queue: s.queue.filter((e) => e.id !== id) }))
    entry.resolve('cancelled')
  },

  withdrawThread: (threadId) => {
    for (const e of get().queue.filter((q) => q.threadId === threadId)) {
      get().withdraw(e.id)
    }
  },

  attachPresenter: () => {
    set((s) => ({ presenters: s.presenters + 1 }))
    let detached = false
    return () => {
      if (detached) return
      detached = true
      set((s) => ({ presenters: Math.max(0, s.presenters - 1) }))
      // Nobody left to answer: release whoever is waiting.
      if (get().presenters === 0) {
        for (const e of [...get().queue]) get().withdraw(e.id)
      }
    }
  },
}))

/** A model-facing result, as JSON text so every provider passes it through. */
function result(status: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ status, ...fields })
}

export type RunAccessRequestOptions = {
  dataFolder: string
  bypass?: boolean
  scope?: WorkspaceScope
  taskLabel?: string
  origin?: string
  signal?: AbortSignal
  /** Recorded with every audit entry this request writes. */
  audit?: AccessAuditIds
}

/**
 * Carry one `request_access` call from the model to the user and back.
 *
 * Returns what the tool call answers the model with. Never throws for a "no":
 * a refusal, a denial, a withdrawn prompt and a surface nobody can answer from
 * are all ordinary, structured results, each telling the model what to do next
 * so it does not loop on the same request.
 */
export async function runAccessRequest(
  input: unknown,
  threadId: string,
  opts: RunAccessRequestOptions
): Promise<string> {
  const args = (input && typeof input === 'object' ? input : {}) as Record<
    string,
    unknown
  >
  const path = typeof args.path === 'string' ? args.path : ''
  const reason =
    typeof args.reason === 'string' ? args.reason.trim().slice(0, 500) : ''
  const rawMode =
    typeof args.access_mode === 'string' ? args.access_mode : 'read'
  const accessMode: AccessMode = rawMode === 'write' ? 'write' : 'read'
  if (rawMode !== 'read' && rawMode !== 'write') {
    return result('refused', {
      code: 'invalid_mode',
      message: 'access_mode must be "read" or "write"',
    })
  }
  if (!reason) {
    return result('refused', {
      code: 'missing_reason',
      message: 'Say in `reason` what you need from this path and why.',
      next: 'Call request_access again with a reason.',
    })
  }

  const prepared = await prepareAccess({
    dataFolder: opts.dataFolder,
    sessionId: threadId,
    path,
    accessMode,
    reason,
    scope: opts.scope,
    audit: opts.audit,
  })
  if (prepared.status === 'refused') return prepared.modelResult
  if (opts.signal?.aborted) {
    return result('cancelled', {
      path: prepared.display,
      message: 'The request was withdrawn before access was granted.',
    })
  }

  const decision =
    (opts.bypass || useToolApproval.getState().permissionMode === 'bypass')
      ? 'session'
      : await useAccessRequests.getState().ask(
          {
            threadId,
            taskLabel: opts.taskLabel,
            origin: opts.origin,
            reason,
            prepared,
          },
          opts.signal
        )

  if (decision === 'unavailable') {
    return result('unavailable', {
      path: prepared.display,
      message:
        'No approval prompt can be shown right now, so nothing was granted.',
      next: 'Do not retry. Ask the user in your reply to paste or attach what you need.',
    })
  }
  if (decision === 'timed-out') {
    void recordAccessDecision({
      dataFolder: opts.dataFolder,
      sessionId: threadId,
      path: prepared.display,
      accessMode,
      decision: 'cancelled',
      audit: opts.audit,
    }).catch(() => undefined)
    return result('timed_out', {
      path: prepared.display,
      message:
        'The access request timed out without an answer; continue without it.',
      next: 'Do not request this path again in this run. Say in your reply what you could not check.',
    })
  }
  if (decision === 'cancelled' || decision === 'deny') {
    void recordAccessDecision({
      dataFolder: opts.dataFolder,
      sessionId: threadId,
      path: prepared.display,
      accessMode,
      decision: decision === 'cancelled' ? 'cancelled' : 'denied',
      audit: opts.audit,
    }).catch(() => undefined)
    if (decision === 'cancelled') {
      return result('cancelled', {
        path: prepared.display,
        message: 'The request was withdrawn before the user answered.',
      })
    }
    return result('denied', {
      path: prepared.display,
      mode: accessMode,
      message: 'The user declined access to this path.',
      next:
        'Do not request this path again. Tell the user what you could not check, ' +
        'and offer another way: they can paste or attach the relevant content, ' +
        'point you to a different source, or you can answer from what you already have.',
    })
  }

  try {
    if (opts.signal?.aborted) {
      return result('cancelled', {
        path: prepared.display,
        message: 'The request was withdrawn before access was granted.',
      })
    }
    const grant = await grantAccess({
      dataFolder: opts.dataFolder,
      sessionId: threadId,
      path: prepared.display,
      accessMode,
      reason,
      persistent: decision === 'always',
      scope: opts.scope,
      audit: opts.audit,
    })
    return result('granted', {
      path: grant.display,
      mode: grant.mode,
      kind: grant.isDir ? 'folder' : 'file',
      scope: grant.persistent ? 'kept until revoked' : 'this conversation',
      next:
        'Access is active now. Retry the call that needed it, with the same path. ' +
        (accessMode === 'read'
          ? 'This grant is read-only; writing there needs its own request.'
          : 'Reads and writes to this path are allowed.') +
        ' On Windows the read/ls/find/grep tools can use it; the shell may not.',
    })
  } catch (e) {
    return result('refused', {
      code: 'grant_failed',
      message: e instanceof Error ? e.message : String(e),
      next: 'Do not retry the same request.',
    })
  }
}
