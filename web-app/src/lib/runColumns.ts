export type RunColumn = 'run' | 'task' | 'model' | 'status' | 'started' | 'speed' | 'tokens'

/** The Agent Runs table's columns: one whose every value would read "—" is left out, not drawn empty. */
export function runColumns(
  rows: { started?: number | null; speed?: number | null; tokens?: number | null }[]
): RunColumn[] {
  const cols: RunColumn[] = ['run', 'task', 'model', 'status']
  if (rows.length === 0 || rows.some((r) => r.started)) cols.push('started')
  if (rows.length === 0 || rows.some((r) => r.speed)) cols.push('speed')
  if (rows.length === 0 || rows.some((r) => r.tokens)) cols.push('tokens')
  return cols
}
