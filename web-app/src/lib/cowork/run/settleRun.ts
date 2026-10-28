import type { UIMessage } from 'ai'
import { closeBrowserSession } from '@/lib/browserTool'
import { INTERRUPTED_BY_RUN_END } from '@/lib/coworkActivity'
import { endRun, type RunHandle, type RunOutcome } from '@/lib/coworkRunner'
import type { RunOrigins } from '@/lib/coworkOrigins'
import {
  deriveFromSubagent,
  deriveFromTurns,
  type FileActivityEvent,
  type FileOrigin,
} from '@/lib/fileActivity'
import { answerMail, finalAnswerText, type MailLedger } from '@/lib/mailAutoReply'
import { notifyAnswerFinished } from '@/lib/completionSound'
import { useAppState } from '@/hooks/useAppState'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { useCoworkRun, type RunEnding } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useFileActivity } from '@/hooks/useFileActivity'
import { useMessageQueue } from '@/stores/message-queue-store'
import type { CoworkTurn } from '@/types/coworkSession'

/** What a run's ending reads: everything the run produced, named. */
export type SettleRunContext = {
  sid: string
  runId: string
  handle: Pick<RunHandle, 'pendingAsks'>
  runTurns: CoworkTurn[]
  messages: UIMessage[]
  outcome: RunOutcome | null
  thrown: Pick<RunOutcome, 'stoppedBy' | 'errorText'> | null
  origins: RunOrigins
  originOfPath: (path: string) => FileOrigin
  recordOrigins: (input: {
    sessionId: string
    origins: RunOrigins
    events: readonly FileActivityEvent[]
  }) => Promise<unknown> | unknown
  runWorkDone: () => void
  recordRunEnded: (ending: RunEnding | null) => unknown
  mailLedger: MailLedger
  continueWith: string | null
  /** Starts the next request (the route's current runRequest). */
  runAgain: (text: string) => Promise<unknown> | unknown
}

/**
 * The teardown every run goes through, however it ended: release the run,
 * commit its turns, record its file work, and decide what follows.
 */
export function settleRun({
  sid,
  runId,
  handle,
  runTurns,
  messages,
  outcome,
  thrown,
  origins,
  originOfPath,
  recordOrigins,
  runWorkDone,
  recordRunEnded,
  mailLedger,
  continueWith,
  runAgain,
}: SettleRunContext): void {
    // The load card is shared by every Cowork run: only the last one to
    // finish takes it down, so this run ending does not hide another's load.
    const othersRunning = Object.keys(useCoworkRun.getState().runs).some(
      (id) => id !== sid
    )
    if (!othersRunning) useAppState.getState().updateLoadingModel(false)
    endRun(sid, runId)
    // The run's agent browser (the `browser` tool) ends with it.
    void closeBrowserSession(sid)
    // The run is over, so its budget is not outstanding any more. Left
    // behind, it would tell the next run it was resuming this one.
    useCoworkSessions.getState().setRunBudget(sid, null)
    // Nothing can still be running once the turn is over: the streams are
    // closed and the dispatch loop has stopped awaiting them. Settle before
    // closing the workflow, so its status is derived from settled children.
    // This run's orphans only — scoped to its own workflow, and leaving a
    // backgrounded shell job alone: the process is still running, and
    // marking it cancelled would be false at the moment it was written and
    // unrepairable afterwards.
    useCoworkActivity.getState().settleRun(runId, INTERRUPTED_BY_RUN_END)
    useCoworkActivity.getState().finishWorkflow(runId)
    useCoworkSessions
      .getState()
      .commitTurns(
        sid,
        runTurns,
        outcome?.messages ?? messages,
        useCoworkRun.getState().subagents[sid] ?? [],
        outcome?.usage ?? undefined
      )
    // The transcript's tool rows are structured: name, arguments, error
    // flag, diff. That is the only thing the file record is built from.
    // A final sweep: anything the steps missed, plus every subagent's own
    // file work, which only exists on the runs themselves.
    const settledAt = Date.now()
    const subagentRuns = useCoworkRun.getState().subagents[sid] ?? []
    const fileEvents = [
      ...deriveFromTurns(runTurns, originOfPath, settledAt),
      ...subagentRuns.flatMap((run) =>
        deriveFromSubagent(run.name, run.turns, originOfPath, settledAt)
      ),
    ]
    useFileActivity.getState().record(sid, fileEvents)
    // The run's own account of what changed, generated from evidence rather
    // than written by the model that did the changing.
    void recordOrigins({ sessionId: sid, origins, events: fileEvents })
    runWorkDone()
    // Unanswered questions end with the run that asked them.
    for (const resolve of handle.pendingAsks.values()) resolve(null)
    handle.pendingAsks.clear()
    const stop = thrown?.stoppedBy ?? outcome?.stoppedBy ?? null
    // Refused if this run no longer owns the session -- stopped and
    // replaced, or the session deleted -- so a late ending lands nowhere.
    const ending: RunEnding | null = stop
      ? {
          stoppedBy: stop,
          errorText: thrown?.errorText ?? outcome?.errorText,
        }
      : null
    useCoworkRun.getState().finishRun(sid, runId, ending)
    recordRunEnded(ending)
    // The answer to a session that asked this one something: sent after the
    // run is recorded as over, and only for a run that finished on its own.
    if (stop === 'done') {
      const asked = mailLedger.unanswered()
      if (asked.length > 0) {
        void answerMail(sid, asked, finalAnswerText(outcome?.messages ?? []))
      }
    }
    // Only a run that finished on its own, and not one about to go on with
    // what was queued behind it: that one sounds when it ends.
    if (stop === 'done' && !continueWith) notifyAnswerFinished()
    // A finished run lets what was typed after its last boundary go as the
    // next request, from the effect watching the session in view. Any other
    // ending -- a failure, Stop, a cap -- holds it for the user to send or
    // discard: it was typed for a run that did not see it, and neither
    // dropping it silently nor sending it on its own is right.
    // janhq/jan#8864.
    if (stop && stop !== 'done') useMessageQueue.getState().holdQueue(sid)
    // Only after a clean finish: a stopped or failed opening run must not
    // start work on its own.
    if (continueWith && stop === 'done') {
      void runAgain(continueWith)
    }
}
