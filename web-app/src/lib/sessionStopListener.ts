/**
 * The target side of `stop_session` (docs/SESSION_MESSAGING.md).
 *
 * `agent-session-stop-requested` carries ids only. The event proves nothing:
 * the request is re-read from the backend, which returns it only when it is
 * addressed to this session, still `requested`, fresh, and names the run the
 * backend has on record. It is then applied only if that run is also the one
 * this renderer has in flight, through `abortRun` -- the user's Stop button --
 * so the model stream, tools, subagents and open questions stop the same way.
 * Afterwards the session's transcript gets a persisted, display-only row
 * saying who stopped it and why, and the backend is told what happened.
 */
import { abortRun, getRunHandle } from '@/lib/coworkRunner'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import {
  sessionMailbox,
  type SessionMailbox,
  type StopRequest,
  type StopRequestedPayload,
} from '@/lib/sessionMailbox'
import type { CoworkTurn } from '@/types/coworkSession'

/** The abort reason a stop by another session carries. */
export const STOP_ABORT_REASON = 'stopped-by-session'

export type StopListenerOutcome =
  | 'invalid'
  | 'duplicate'
  | 'unknown-session'
  | 'no-record'
  | 'ignored-stale'
  | 'applied'

type ListenerMailbox = Pick<SessionMailbox, 'pendingStop' | 'resolveStop'>

export type StopListenerDeps = {
  mailbox?: ListenerMailbox
  abort?: (sid: string, reason: string) => void
  getHandle?: (sid: string) => { runId: string } | undefined
  /** How long to wait for the stopped run to commit before adding the row. */
  waitMs?: number
}

export function stopNoticeTurn(request: StopRequest, at = Date.now()): CoworkTurn {
  return {
    role: 'assistant',
    content: '',
    stopNotice: {
      requestId: request.id,
      fromSessionId: request.from.sessionId,
      fromName: request.from.displayName,
      reason: request.reason,
      at,
    },
  }
}

/** Resolves once `sid` no longer has run `runId` in flight, or after `ms`. */
function waitForRunEnd(sid: string, runId: string, ms: number): Promise<void> {
  const over = () => useCoworkRun.getState().runs[sid]?.runId !== runId
  if (over()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let off = () => {}
    const timer = setTimeout(() => {
      off()
      resolve()
    }, ms)
    off = useCoworkRun.subscribe(() => {
      if (!over()) return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
}

export function createStopListener(deps: StopListenerDeps = {}) {
  const mailbox = deps.mailbox ?? sessionMailbox
  const abort = deps.abort ?? abortRun
  const getHandle = deps.getHandle ?? getRunHandle
  const waitMs = deps.waitMs ?? 10_000
  const inFlight = new Set<string>()

  const onEvent = async (
    payload: StopRequestedPayload | undefined
  ): Promise<StopListenerOutcome> => {
    const sid = payload?.sessionId
    const requestId = payload?.requestId
    if (typeof sid !== 'string' || !sid || typeof requestId !== 'string' || !requestId) {
      return 'invalid'
    }
    if (inFlight.has(requestId)) return 'duplicate'
    inFlight.add(requestId)
    try {
      if (!useCoworkSessions.getState().sessions.some((s) => s.id === sid)) {
        return 'unknown-session'
      }
      let request: StopRequest | null
      try {
        request = await mailbox.pendingStop(sid, requestId)
      } catch (e) {
        console.warn('[stop] reading the request failed:', e)
        return 'no-record'
      }
      if (!request || request.to.sessionId !== sid || request.id !== requestId) {
        return 'no-record'
      }

      const run = useCoworkRun.getState().runs[sid]
      const handle = getHandle(sid)
      const isThatRun =
        run?.runId === request.targetRunId && handle?.runId === request.targetRunId
      if (!isThatRun) {
        await mailbox
          .resolveStop({
            sessionId: sid,
            requestId,
            applied: false,
            runId: run?.runId ?? null,
          })
          .catch((e) => console.warn('[stop] resolve failed:', e))
        return 'ignored-stale'
      }

      abort(sid, STOP_ABORT_REASON)
      // After the stopped run has committed its turns, so the row lands
      // below what that run said and is persisted with the session.
      await waitForRunEnd(sid, request.targetRunId, waitMs)
      useCoworkSessions.getState().appendTurns(sid, [stopNoticeTurn(request)])
      await mailbox
        .resolveStop({
          sessionId: sid,
          requestId,
          applied: true,
          runId: request.targetRunId,
        })
        .catch((e) => console.warn('[stop] resolve failed:', e))
      return 'applied'
    } finally {
      inFlight.delete(requestId)
    }
  }

  return { onEvent }
}

let singleton: ReturnType<typeof createStopListener> | null = null

export function getStopListener() {
  singleton ??= createStopListener()
  return singleton
}
