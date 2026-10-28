// Fields the triage owns on a queue record. A rebuild never clobbers these,
// and set-record.mjs refuses to write anything else into an item.
export const OWNED = [
  'forkReproduction',
  'decision',
  'decisionReason',
  'implementationStatus',
  'forkCommits',
  'tests',
  'verification',
  'blockers',
  'registryIds',
  'notes',
]

/** The keys of `patch` that triage does not own. */
export function foreignKeys(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return ['(patch is not an object)']
  return Object.keys(patch).filter((k) => !OWNED.includes(k))
}
