/**
 * How much of each turn the Chat, Cowork and Rooms transcripts show.
 *
 * Presentation only: nothing is removed from the conversation, its exports or
 * its search, and switching modes takes effect without a reload.
 *
 * - `normal`: the answer and what needs the user. Reasoning is hidden and a
 *   turn's tool calls fold into one "N steps" disclosure.
 * - `thinking`: as normal, plus the reasoning summaries.
 * - `verbose`: everything, expanded.
 *
 * In every mode a call awaiting approval stays on screen, as do asks, run
 * errors and result cards (those are not trace parts at all). A failed call
 * is one of the steps in `normal`, a collapsed row of its own in `thinking`
 * and an open row in `verbose`.
 */
export const TRANSCRIPT_VIEWS = ['normal', 'thinking', 'verbose'] as const
export type TranscriptView = (typeof TRANSCRIPT_VIEWS)[number]
export const DEFAULT_TRANSCRIPT_VIEW: TranscriptView = 'normal'

export const isTranscriptView = (value: unknown): value is TranscriptView =>
  typeof value === 'string' &&
  (TRANSCRIPT_VIEWS as readonly string[]).includes(value)

type TracePart = { type: string; state?: string; toolCallId?: string }
type TraceEntry = { part: TracePart; index: number }

export type TracePartition<E> = {
  /** Reasoning shown in the trace (only in `thinking`). */
  reasoning: E[]
  /** Tool calls that stay visible: awaiting approval, and in `thinking`
   * failed calls too. */
  pinned: E[]
  /** Tool calls folded into the "N steps" disclosure. */
  steps: E[]
}

/**
 * Split one reasoning/tool trace for the compact modes. `verbose` renders the
 * trace whole and does not call this.
 */
export function partitionTrace<E extends TraceEntry>(
  view: Exclude<TranscriptView, 'verbose'>,
  entries: E[],
  isAwaitingApproval: (toolCallId: string) => boolean
): TracePartition<E> {
  const out: TracePartition<E> = { reasoning: [], pinned: [], steps: [] }
  for (const entry of entries) {
    const { part } = entry
    if (part.type.startsWith('tool-')) {
      const pending = Boolean(
        part.toolCallId && isAwaitingApproval(part.toolCallId)
      )
      // A page shown to the user stays in view: it is the result, not a step.
      const shown =
        part.type === 'tool-open_in_browser' && part.state === 'output-available'
      if (
        pending ||
        shown ||
        (view === 'thinking' && part.state === 'output-error')
      )
        out.pinned.push(entry)
      else out.steps.push(entry)
    } else if (view === 'thinking') {
      out.reasoning.push(entry)
    }
  }
  return out
}
