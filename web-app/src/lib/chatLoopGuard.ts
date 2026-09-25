/**
 * The run-loop guard (`runLoopGuard.ts`) for Chat.
 *
 * Cowork checks every call against the run's history and stops a run that has
 * stopped getting anywhere. Chat had no such check: a model calling a tool
 * that kept failing ran until the consecutive auto-approval prompt ("50 tool
 * calls ran without asking. Continue?"), which only offered to go on.
 *
 * A Chat turn is one assistant message: the SDK's auto-resubmit continues the
 * same message after each round of tool results, so the history is kept per
 * thread and starts over when a new assistant message begins.
 *
 * The first trip refuses the call and tells the model to stop and explain,
 * leaving it one more reply. A model that calls tools again after being told
 * has used that reply, and the turn is ended (`end: true`).
 */

import {
  detectLoop,
  loopFinalTurnNote,
  loopStopMessage,
  type LoopVerdict,
  type ObservedCall,
} from '@/lib/runLoopGuard'

type TurnHistory = { messageId: string; calls: ObservedCall[]; stopped: boolean }

const turns = new Map<string, TurnHistory>()

function historyFor(threadId: string, messageId: string): TurnHistory {
  const known = turns.get(threadId)
  if (known && known.messageId === messageId) return known
  const fresh: TurnHistory = { messageId, calls: [], stopped: false }
  turns.set(threadId, fresh)
  return fresh
}

export type ChatLoopStop = {
  verdict: LoopVerdict & { tripped: true }
  /** What the refused call returns to the model (and shows in its card). */
  errorText: string
  /** The model was already told once this turn: end the turn now. */
  end: boolean
}

/**
 * Checked before a Chat tool call runs. Returns why it must not run, or null.
 */
export function chatLoopStop(threadId: string, messageId: string): ChatLoopStop | null {
  const turn = historyFor(threadId, messageId)
  const verdict = detectLoop(turn.calls)
  if (!verdict.tripped) return null
  const end = turn.stopped
  turn.stopped = true
  return {
    verdict,
    errorText: `${loopStopMessage(verdict)}\n\n${loopFinalTurnNote(verdict)}`,
    end,
  }
}

/** Records how a Chat tool call ended, for the next check. */
export function noteChatToolCall(
  threadId: string,
  messageId: string,
  call: ObservedCall
): void {
  historyFor(threadId, messageId).calls.push(call)
}

export const __testing = { reset: () => turns.clear() }
