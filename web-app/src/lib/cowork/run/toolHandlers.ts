import { toast } from 'sonner'
import { attachAskToTurns, settleAskInTurns } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { parseAskRequest, renderAskResult } from '@/lib/coworkAsk'
import {
  CONTINUE_QUESTION_ID,
  acceptsProposal,
  continuationInstruction,
  PROPOSAL_ACCEPTED_RESULT,
} from '@/lib/coworkContinuity'
import {
  planReviewDecision,
  renderPlanReviewResult,
  planExecuteNotice,
  PLAN_EXECUTE_INSTRUCTION,
} from '@/lib/coworkPlanReview'
import type { beginRun, ToolOutcome } from '@/lib/coworkRunner'
import { applyTodoOp, renderTodoResult } from '@/lib/coworkTodo'
import { parseEnableRequest } from '@/lib/coworkToolGroups'
import type { CoworkChatTransport } from '@/lib/coworkTransport'
import type { CoworkTurn } from '@/types/coworkSession'
import type { RunState } from './runState'

/** What a run's todo, ask and tool-group handlers read and write. */
export type ToolHandlersContext = {
  rs: RunState
  sid: string
  /** The session's folder when the run started. */
  folder: string | null | undefined
  access: string
  /** The opening turn runs read-only and proposes. */
  inspecting: boolean
  planAnchor: string | undefined
  handle: ReturnType<typeof beginRun>
  transport: Pick<
    CoworkChatTransport,
    'heldGroups' | 'openedGroups' | 'advertisedGroups' | 'openGroupsNow'
  >
  mutateLive: (apply: (turns: CoworkTurn[]) => CoworkTurn[]) => void
  t: (key: string, options?: Record<string, unknown>) => string
}

/** The dispatcher's `onEnableTools`, `onTodo` and `onAsk` for a main run. */
export function createToolHandlers(ctx: ToolHandlersContext) {
  const { rs, sid, handle, transport, mutateLive } = ctx
  const onEnableTools = (input: unknown): ToolOutcome => {
    const parsed = parseEnableRequest(
      input,
      transport.heldGroups,
      transport.openedGroups,
      transport.advertisedGroups
    )
    if (typeof parsed === 'string') {
      return { output: `ERROR: ${parsed}`, isError: true }
    }
    const added = transport.openGroupsNow(parsed.groups)
    return {
      output:
        added.length > 0
          ? `Loaded ${added.length} tools: ${added.join(', ')}. Use them from your next step.`
          : 'Those tools are already loaded.',
    }
  }
  const onTodo = async (input: unknown): Promise<ToolOutcome> => {
    const result = applyTodoOp(
      useCoworkSessions
        .getState()
        .sessions.find((s) => s.id === sid)?.todos,
      input
    )
    if (result.error) {
      return { output: `ERROR: ${result.error}`, isError: true }
    }
    // Snapshot anchored at this run's prompt, so the transcript
    // keeps one record of the plan per run.
    useCoworkSessions
      .getState()
      .setTodos(sid, result.list, ctx.planAnchor)
    return { output: renderTodoResult(result.list) }
  }
  const onAsk = (callId: string, input: unknown) =>
    new Promise<ToolOutcome>((resolve) => {
      const parsed = parseAskRequest(input)
      if (typeof parsed === 'string') {
        resolve({ output: `ERROR: ${parsed}`, isError: true })
        return
      }
      // In the transcript, at the point the run asked -- not in a
      // slot above the composer. It stays there once answered.
      const askRecord = {
        requestId: callId,
        request: parsed,
        sessionId: sid,
        callId,
        at: new Date().toISOString(),
        state: 'pending' as const,
      }
      // Into this run's own lane, whichever session is in view:
      // that lane is what renders for this session.
      mutateLive((turns) => attachAskToTurns(turns, askRecord))
      // The opening turn ends on a named question. Recording the
      // wait is what makes a session reopened at this point restore
      // an unanswered proposal rather than resume into work.
      const proposal = parsed.questions.find(
        (one) => one.id === CONTINUE_QUESTION_ID
      )
      if (proposal && ctx.folder) {
        useCoworkSessions.getState().setContinuity(sid, {
          state: 'awaiting-continuation',
          folder: ctx.folder,
          proposal: proposal.question,
        })
      }
      // Held by this run's handle: answered only through this
      // session, and settled by stopping this session alone.
      handle.pendingAsks.set(callId, (answers) => {
        const state = answers ? 'answered' : 'cancelled'
        mutateLive((turns) =>
          settleAskInTurns(turns, callId, state, answers ?? undefined)
        )
        // An answered proposal is no longer outstanding. Declining
        // is recorded as a decision, not as work to pick up later.
        if (proposal && ctx.folder) {
          useCoworkSessions.getState().setContinuity(sid, {
            state: answers ? 'executing' : 'cancelled',
            folder: ctx.folder,
            proposal: proposal.question,
          })
        }
        // An accepted opening proposal ends this read-only run
        // and continues in a new one that can write (#296).
        if (
          ctx.inspecting &&
          proposal &&
          answers &&
          acceptsProposal(parsed, answers)
        ) {
          rs.continueWith = continuationInstruction(
            proposal.question,
            answers
          )
          resolve({
            output: PROPOSAL_ACCEPTED_RESULT,
            endsTurn: true,
          })
          return
        }
        // A plan review changes the session's mode, from the next
        // message: this run's tools are frozen. Only ever towards
        // Ask, where each change still waits for the user.
        const review = planReviewDecision(parsed, answers)
        if (review === 'execute' || review === 'exit') {
          useCoworkSessions.getState().setMode(sid, 'ask')
        }
        // "Execute plan" leaves plan mode and carries on: this
        // run's tools are frozen read-only, so it ends and the
        // plan continues in a new run that can make changes.
        // When those changes cannot reach the user's files, the
        // user is told what to change rather than left to find
        // "Attach a folder first" in the access menu.
        if (review === 'execute') {
          const notice = planExecuteNotice({
            folder: ctx.folder,
            access: ctx.access,
          })
          if (notice) {
            toast.info(ctx.t(`common:coworkPlanExecute.${notice}`), {
              duration: 12000,
            })
          }
          rs.continueWith = PLAN_EXECUTE_INSTRUCTION
        }
        resolve(
          review === 'none'
            ? renderAskResult(answers, parsed)
            : renderPlanReviewResult(review, answers)
        )
      })
    })
  return { onEnableTools, onTodo, onAsk }
}
