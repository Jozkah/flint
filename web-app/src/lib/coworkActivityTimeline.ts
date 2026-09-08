/**
 * The activity timeline, reconciled against the canonical record. AH-172.
 *
 * The transcript in the session store is what the UI built while a run was
 * happening; the event log written by `toolActivity` is what actually
 * happened. Where they disagree the record wins, because it survives things
 * the transcript does not -- a killed process, a window closed mid-run, a
 * result that arrived after the run was already committed.
 *
 * Nothing is ever removed here. A call that ran is part of what the session
 * did, and a timeline that drops it cannot answer the question it exists for.
 */
import type { CoworkTurn } from '@/types/coworkSession'
import type { ToolActivityItem, ToolActivityPhase } from '@/lib/toolActivity'

/** The record's phases mapped onto the turn states the renderer knows. */
function turnStateFor(phase: ToolActivityPhase): CoworkTurn['toolState'] {
  switch (phase) {
    case 'allowed':
      // Permission was given, so the call is under way.
      return 'running'
    case 'timed-out':
      // Shown as a failure, but the detail still says it timed out.
      return 'failed'
    default:
      return phase
  }
}

/** A turn built from the record alone, for a call the transcript lost. */
function turnFromItem(item: ToolActivityItem): CoworkTurn {
  return {
    role: 'tool',
    content: '',
    callId: item.call,
    name: item.tool,
    args: item.resource ? { resource: item.resource } : undefined,
    result: item.detail || undefined,
    isError: item.phase === 'failed' || item.phase === 'timed-out',
    status: item.phase === 'running' ? 'running' : 'done',
    toolState: turnStateFor(item.phase),
    runId: item.run || undefined,
    agent: item.agent || undefined,
    exitCode: item.exit_code ?? undefined,
  }
}

/**
 * Fold the record into a transcript.
 *
 * A call already in the transcript keeps its arguments, output and diff -- the
 * record does not carry those, by design, since it must not become a second
 * copy of everything a tool printed. What it does carry is what became of the
 * call, and that replaces whatever the transcript believed.
 */
export function reconcileToolActivity(
  turns: CoworkTurn[],
  items: ToolActivityItem[]
): CoworkTurn[] {
  if (!items || items.length === 0) return turns

  const byCall = new Map(items.map((item) => [item.call, item]))
  const seen = new Set<string>()

  const merged = turns.map((turn) => {
    if (turn.role !== 'tool' || !turn.callId) return turn
    const item = byCall.get(turn.callId)
    if (!item) return turn
    seen.add(turn.callId)

    const toolState = turnStateFor(item.phase)
    const isError =
      item.phase === 'failed' ||
      item.phase === 'timed-out' ||
      item.phase === 'refused' ||
      turn.isError
    // A turn already agreeing with the record is returned unchanged, so a
    // reconciled transcript is stable and does not re-render on every pass.
    if (turn.toolState === toolState && turn.isError === isError) return turn
    return {
      ...turn,
      toolState,
      isError,
      status: item.phase === 'running' ? ('running' as const) : ('done' as const),
      exitCode: turn.exitCode ?? item.exit_code ?? undefined,
      agent: turn.agent ?? (item.agent || undefined),
      runId: turn.runId ?? (item.run || undefined),
      // Only when the turn has nothing of its own: the record's detail is a
      // short redacted note, not the tool's output.
      result: turn.result ?? (item.detail || undefined),
    }
  })

  // Calls the record has and the transcript does not. Appended in the order
  // they were requested, which is the order the record already keeps.
  const missing = items
    .filter((item) => !seen.has(item.call))
    .map(turnFromItem)

  return missing.length > 0 ? [...merged, ...missing] : merged
}
