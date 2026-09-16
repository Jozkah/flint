/**
 * An explicit "we're done" signal a participant can raise.
 *
 * Round-robin rooms with no moderator otherwise run every round to the limit,
 * even once the objective is plainly met — the models keep restating a settled
 * conclusion. So a participant may end its message with a line holding exactly
 * {@link CONCLUDE_SIGNAL}; the engine then closes the room (converged, by
 * consensus) instead of grinding out the remaining rounds. The signal is
 * deliberately explicit and unlikely to appear by accident, and it is honoured
 * only in modes where no moderator is deciding when to stop.
 */
export const CONCLUDE_SIGNAL = '[[CONCLUDED]]'

/**
 * Split a reply into whether it concluded the discussion and the text to show
 * (the signal line removed, so it never appears in the transcript). A signal
 * anywhere in the reply counts, but the model is asked to put it on its own
 * final line.
 */
export function stripConclusion(raw: string): { concluded: boolean; text: string } {
  if (!raw.includes(CONCLUDE_SIGNAL)) return { concluded: false, text: raw }
  const text = raw
    .split('\n')
    .filter((line) => !line.includes(CONCLUDE_SIGNAL))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { concluded: true, text }
}
