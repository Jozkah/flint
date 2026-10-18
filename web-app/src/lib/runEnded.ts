/**
 * How a run ended, as the Rust loop reports it (`run_ended`, see `end_reason.rs`).
 *
 * One typed reason for every ending, so the sentence shown beside a finished
 * run does not depend on which surface (or which error text) the ending came
 * through. The Rust side sends its own `label`; this keeps the same sentences
 * for a surface that only has the tag, such as a stored run record.
 */
export type RunEndReason =
  | 'completed'
  | 'user_stop'
  | 'budget'
  | 'turn_limit'
  | 'refusal'
  | 'error'
  | 'lease_lost'

export type RunEndedEvent = {
  type: 'run_ended'
  reason: string
  label: string
  exit_code: number
}

const LABELS: Record<RunEndReason, string> = {
  completed: 'Finished.',
  user_stop: 'Stopped by you.',
  budget: 'Stopped: the budget ran out.',
  turn_limit: 'Stopped: the turn limit was reached before the work was done.',
  refusal: 'Stopped: the request was refused.',
  error: 'Stopped: the run failed.',
  lease_lost: 'Stopped: another process took over this run.',
}

export const isRunEndReason = (tag: string): tag is RunEndReason =>
  Object.prototype.hasOwnProperty.call(LABELS, tag)

/**
 * The sentence for a run ending. Prefers the label the loop sent; an unknown
 * tag (a newer loop) falls back to its label, then to the generic failure
 * sentence rather than to nothing.
 */
export function describeRunEnd(event: Pick<RunEndedEvent, 'reason' | 'label'>): string {
  if (event.label.trim()) return event.label
  return isRunEndReason(event.reason) ? LABELS[event.reason] : LABELS.error
}

/** A run that ended any way but completing needs the person's attention. */
export const runEndNeedsAttention = (reason: string): boolean => reason !== 'completed'
