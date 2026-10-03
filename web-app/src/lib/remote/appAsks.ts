// The questions this window's Cowork runs are waiting on, read from the
// stores (see `asks.ts` for the rules).

import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { getRunHandle } from '@/lib/coworkRunner'
import type { CoworkTurn } from '@/types/coworkSession'
import { pendingAsks } from './asks'
import type { RemoteAsk } from './protocol'

/** Whether the run that asked is still there to take the answer. */
const held = (sid: string, requestId: string) =>
  getRunHandle(sid)?.pendingAsks.has(requestId) === true

export function asksIn(liveTurns: Record<string, CoworkTurn[] | undefined>): RemoteAsk[] {
  return pendingAsks(
    liveTurns,
    held,
    (sid) => useCoworkSessions.getState().sessions.find((s) => s.id === sid)?.todos
  )
}

export const appAsks = (): RemoteAsk[] => asksIn(useCoworkRun.getState().liveTurns)
