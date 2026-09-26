import type { CoworkTurn, SubagentRun } from '@/types/coworkSession'

export type CoworkDiffOperation = {
  diff: string
  /** Who made the change: the run, a subagent, or the user by hand. */
  source: 'main' | 'subagent' | 'user'
  sourceName?: string
}

export type CoworkFileDiff = {
  path: string
  additions: number
  deletions: number
  operations: CoworkDiffOperation[]
}

function addOperation(
  files: Map<string, CoworkFileDiff>,
  turn: CoworkTurn,
  source: CoworkDiffOperation['source'],
  sourceName?: string
) {
  if (
    turn.role !== 'tool' ||
    (turn.name !== 'write' && turn.name !== 'edit') ||
    turn.isError ||
    turn.status === 'running' ||
    !turn.diff
  ) {
    return
  }
  if (!turn.args || typeof turn.args !== 'object') return

  const path = (turn.args as Record<string, unknown>).path
  if (typeof path !== 'string' || !path.trim()) return

  const lines = turn.diff.split('\n')
  const additions = lines.filter((line) => line.startsWith('+ ')).length
  const deletions = lines.filter((line) => line.startsWith('- ')).length
  const operation: CoworkDiffOperation = sourceName
    ? { diff: turn.diff, source, sourceName }
    : { diff: turn.diff, source }
  const current = files.get(path)

  if (current) {
    current.additions += additions
    current.deletions += deletions
    current.operations.push(operation)
    return
  }

  files.set(path, { path, additions, deletions, operations: [operation] })
}

export function collectCodeFileDiffs(
  turns: CoworkTurn[],
  subagents: SubagentRun[],
  /** Saves the user made in the Code panel, in the order they were made. */
  userEdits: readonly { writtenPath: string; diff?: string }[] = []
): CoworkFileDiff[] {
  const files = new Map<string, CoworkFileDiff>()

  for (const turn of turns) {
    addOperation(files, turn, 'main')
  }

  for (const run of subagents) {
    for (const turn of run.turns) {
      addOperation(files, turn, 'subagent', run.name)
    }
  }

  for (const edit of userEdits) {
    if (!edit.diff || !edit.writtenPath.trim()) continue
    addOperation(
      files,
      {
        role: 'tool',
        name: 'write',
        args: { path: edit.writtenPath },
        diff: edit.diff,
        status: 'done',
      } as unknown as CoworkTurn,
      'user'
    )
  }

  return [...files.values()]
}

/**
 * The row a focus request names: an exact path first, then one path ending
 * with the other (a tool's absolute path against Git's repository-relative
 * one), compared with `/` separators and without case on Windows drives.
 */
export function findFocusedRow(
  ids: readonly string[],
  focusPath: string
): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')
  const want = norm(focusPath)
  const pathOf = (id: string) => norm(id.slice(id.indexOf(':') + 1))
  const exact = ids.find((id) => pathOf(id) === want)
  if (exact) return exact
  const lower = want.toLowerCase()
  return (
    ids.find((id) => {
      const have = pathOf(id).toLowerCase()
      return (
        (lower.endsWith(`/${have}`) || have.endsWith(`/${lower}`)) &&
        have.length > 0
      )
    }) ?? null
  )
}
