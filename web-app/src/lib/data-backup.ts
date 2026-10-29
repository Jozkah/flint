/** Suggested file name for a whole-data backup. */
export function defaultDataBackupName(now = new Date()): string {
  return `flint-data-${now.toISOString().slice(0, 10)}.json`
}
