/**
 * Who else is working in the same turn.
 *
 * A child started while others of the same run are still going is told their
 * names and one-line errands, so it does not redo their work. Names and errand
 * titles only: never a sibling's transcript, tools or result.
 */

export type RosterEntry = { name: string; errand: string }

const active = new Map<string, Map<string, RosterEntry>>()

/** Most siblings named; the rest are counted. */
export const MAX_ROSTER = 8
const MAX_ERRAND_CHARS = 120

/** One line from a title or brief: first non-empty line, trimmed, bounded. */
export function errandLine(title: string | undefined, description: string): string {
  const source = title?.trim() || description.split('\n').find((l) => l.trim()) || ''
  const one = source.replace(/\s+/g, ' ').trim()
  return one.length > MAX_ERRAND_CHARS ? `${one.slice(0, MAX_ERRAND_CHARS - 1)}…` : one
}

/** The other children now active in `runId`, then record this one. Returns the release. */
export function joinRoster(
  runId: string,
  callId: string,
  entry: RosterEntry
): { siblings: RosterEntry[]; leave: () => void } {
  let run = active.get(runId)
  if (!run) active.set(runId, (run = new Map()))
  const siblings = [...run.entries()].filter(([id]) => id !== callId).map(([, e]) => e)
  run.set(callId, entry)
  return {
    siblings,
    leave: () => {
      const r = active.get(runId)
      r?.delete(callId)
      if (r && r.size === 0) active.delete(runId)
    },
  }
}

/** The system-prompt block, or undefined when the child works alone. */
export function rosterBlock(siblings: readonly RosterEntry[]): string | undefined {
  if (siblings.length === 0) return undefined
  const shown = siblings.slice(0, MAX_ROSTER)
  const lines = shown.map((s) => `- ${s.name}: ${s.errand}`)
  if (siblings.length > shown.length) lines.push(`- and ${siblings.length - shown.length} more`)
  return [
    '<sibling-agents>',
    'Other subagents are working on this request at the same time. Do not duplicate their errands; stay on yours. You cannot see their work or talk to them.',
    ...lines,
    '</sibling-agents>',
  ].join('\n')
}
