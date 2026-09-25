/**
 * The run-loop guard (`runLoopGuard.ts`) for Chat.
 *
 * Cowork checks every call against the run's history and stops a run that has
 * stopped getting anywhere. Chat had no such check: a model calling a tool
 * that kept failing ran until the consecutive auto-approval prompt ("50 tool
 * calls ran without asking. Continue?"), which only offered to go on.
 *
 * A Chat turn is everything the model does in answer to one user message.
 * The history is keyed by that user message (`chatTurnId`), not by the
 * assistant message id: a provider or transport that starts a new assistant
 * message for each step of the auto-resubmit would otherwise reset the
 * history every step, and a model calling the same tools over and over was
 * never seen to repeat anything.
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

type TurnHistory = { turnId: string; calls: ObservedCall[]; stopped: boolean }

const turns = new Map<string, TurnHistory>()

function historyFor(threadId: string, turnId: string): TurnHistory {
  const known = turns.get(threadId)
  if (known && known.turnId === turnId) return known
  const fresh: TurnHistory = { turnId, calls: [], stopped: false }
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
export function chatLoopStop(threadId: string, turnId: string): ChatLoopStop | null {
  const turn = historyFor(threadId, turnId)
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
  turnId: string,
  call: ObservedCall
): void {
  historyFor(threadId, turnId).calls.push(call)
}

/**
 * The turn a Chat tool call belongs to: the last user message in the
 * conversation, which stays the same across every step of an auto-resubmitted
 * reply. Falls back to the assistant message when there is no user message.
 */
export function chatTurnId(
  messages: ReadonlyArray<{ id: string; role: string }>,
  assistantMessageId: string
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return `user:${messages[i].id}`
  }
  return `assistant:${assistantMessageId}`
}

export const __testing = { reset: () => turns.clear() }
