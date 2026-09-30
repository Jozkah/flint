import type { RunOutcome, UnresolvedItem } from '@/lib/coworkRunOutcome'

/**
 * The run outcome keeps the full evidence trail, including failed attempts that
 * were later recovered. The summary card should not replay that history as if
 * every attempt were still an unresolved problem.
 *
 * Clean completions therefore show no Unresolved section. Interrupted runs keep
 * the stop reason and, for the remaining blockers, only the latest item for each
 * tool and target. Failed checks already have their own Checks section and are not repeated
 * here. Activity/Timeline remains the place to inspect every attempt.
 */
export function unresolvedForSummary(
  outcome: Pick<RunOutcome, 'status' | 'unresolved'>,
  maxBlockers = 3
): UnresolvedItem[] {
  if (outcome.status === 'completed') return []

  const stop = outcome.unresolved.find(
    (item): item is Extract<UnresolvedItem, { kind: 'stop' }> =>
      item.kind === 'stop'
  )

  const seen = new Set<string>()
  const blockers: UnresolvedItem[] = []

  for (let i = outcome.unresolved.length - 1; i >= 0; i -= 1) {
    const item = outcome.unresolved[i]
    if (item.kind === 'stop' || item.kind === 'check-failed') continue

    // Shell targets are command spellings of one blocker; other tools' targets
    // are distinct resources (three refused writes are three blockers).
    const key =
      item.tool === 'bash'
        ? `${item.kind}:${item.tool}`
        : `${item.kind}:${item.tool}:${item.target}`
    if (seen.has(key)) continue
    seen.add(key)
    blockers.push(item)
    if (blockers.length >= maxBlockers) break
  }

  blockers.reverse()
  return stop ? [stop, ...blockers] : blockers
}
