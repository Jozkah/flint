/**
 * The Cowork turn a run is in the middle of, kept with the session as it
 * happens (AH-026).
 *
 * A Cowork session used to be written when its run ended. A run the app was
 * closed or killed under lost that turn entirely: the tool calls it had made
 * and been answered, and the reply it was streaming. Now the run's live turns
 * are checkpointed onto the session while it goes -- at every step, and at
 * most every half second while text streams -- and cleared when the turn is
 * committed. A checkpoint found when no run for that session is live is an
 * interrupted turn, offered back to the user: continue it, or discard the
 * unfinished reply and continue from the last completed step.
 */
import type { UIMessage } from 'ai'
import type { CoworkTurn } from '@/types/coworkSession'
import { coworkTurnsToUIMessages } from '@/lib/coworkTurns'

export type InFlightRecord = {
  runId: string
  startedAt: number
  checkpointAt: number
  /** How many of the session's messages the run started from. */
  baseCount: number
  /** The run's turns as they stood at the checkpoint. */
  turns: CoworkTurn[]
}

export type InterruptedChoice = 'continue' | 'discard-partial'

/** Checkpoints are written at most this often while text streams. */
export const CHECKPOINT_EVERY_MS = 500

/** How a recovery note begins, so nobody mistakes it for the user's words. */
export const RECOVERY_NOTE_PREFIX = 'Note from Flint (not typed by the user): '

/**
 * Whether a checkpoint is due. A step always is; a stream delta only once the
 * last checkpoint is old enough.
 */
export function checkpointDue(
  last: number | undefined,
  now: number,
  step: boolean
): boolean {
  return step || last === undefined || now - last >= CHECKPOINT_EVERY_MS
}

/** The record to keep for a run's live turns. */
export function checkpoint(
  runId: string,
  startedAt: number,
  baseCount: number,
  turns: readonly CoworkTurn[],
  now: number
): InFlightRecord {
  return {
    runId,
    startedAt,
    checkpointAt: now,
    baseCount,
    // A copy: the run keeps mutating its own array.
    turns: turns.map((t) => ({ ...t })),
  }
}

/**
 * A checkpoint is an interrupted turn only when the run it names is not
 * running here. A live run is still writing it.
 */
export function isInterrupted(
  record: InFlightRecord | undefined,
  liveRunId: string | undefined
): record is InFlightRecord {
  return !!record && record.turns.length > 0 && record.runId !== liveRunId
}

const UNFINISHED_STATES = new Set(['requested', 'awaiting-permission', 'running'])

/** A call with no ending: still running, or waiting on something, when the run died. */
function isUnfinishedCall(turn: CoworkTurn): boolean {
  if (turn.toolState) return UNFINISHED_STATES.has(turn.toolState)
  return turn.status === 'running'
}

/** The trailing assistant text the run was still streaming, if any. */
export function unfinishedReply(record: InFlightRecord): string {
  const last = record.turns[record.turns.length - 1]
  return last && last.role === 'assistant' ? last.content : ''
}

/**
 * What the session holds after recovery, as `choice` asks.
 *
 * Completed tool calls and their results are kept either way. A tool that was
 * still running when the run died has no result, so it is closed as
 * interrupted rather than left open. The unfinished reply is kept (continue)
 * or dropped (discard-partial), and a note from Flint says which -- as a user
 * turn marked as Flint's, because it has to reach the model, and the model must
 * not read a status marker in its own voice.
 */
export function recover(
  base: readonly UIMessage[],
  record: InFlightRecord,
  choice: InterruptedChoice,
  sessionId: string
): { turns: CoworkTurn[]; messages: UIMessage[] } {
  let turns = record.turns.map((t) =>
    t.role === 'tool' && isUnfinishedCall(t)
      ? {
          ...t,
          // `stale` is the state a call a dead run left behind is recorded in;
          // the timeline shows it as interrupted.
          status: 'done' as const,
          toolState: 'stale' as const,
          isError: true,
          result: t.result || '(interrupted: the app stopped before this call finished)',
          // #321: kept when saved; a call whose arguments never arrived is
          // replayed with none rather than without the field.
          args: t.args ?? {},
        }
      : t.role === 'tool'
        ? { ...t, args: t.args ?? {} }
        : { ...t }
  )
  const partial = unfinishedReply(record)
  if (choice === 'discard-partial' && partial) {
    turns = turns.slice(0, -1)
  }
  const note =
    RECOVERY_NOTE_PREFIX +
    (!partial
      ? 'The previous run was interrupted; every completed step above is kept. Continue the task.'
      : choice === 'continue'
        ? 'The previous run was interrupted while the reply above was being written; it may be incomplete. Continue the task from there.'
        : 'The previous run was interrupted mid-reply; that unfinished reply was discarded and every completed step above is kept. Continue the task.')
  turns.push({ role: 'user', content: note })
  const messages = [
    ...base.slice(0, record.baseCount),
    ...coworkTurnsToUIMessages(turns, `${sessionId}-recovered-${record.runId.slice(0, 8)}`),
  ]
  return { turns, messages }
}
