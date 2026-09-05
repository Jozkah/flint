import { describe, expect, it } from 'vitest'
import {
  countsByFilter,
  deriveFromTurns,
  eventFromTool,
  groupByFile,
  isChange,
  matchesFilter,
  mergeEvents,
  normalizePath,
  operationForTool,
  pathFromArgs,
  type FileActivityEvent,
} from '@/lib/fileActivity'

const projectOrigin = () => 'project' as const

const event = (over: Partial<FileActivityEvent> = {}): FileActivityEvent => ({
  id: 'e1',
  path: 'src/a.ts',
  operation: 'read',
  seq: 0,
  at: 0,
  ok: true,
  origin: 'project',
  ...over,
})

describe('reading a tool call', () => {
  it('maps the tools that touch files, and only those', () => {
    expect(operationForTool('read')).toBe('read')
    expect(operationForTool('write')).toBe('write')
    expect(operationForTool('grep')).toBe('search')
    expect(operationForTool('ls')).toBe('list')
    // Not file work: no row should appear for these.
    expect(operationForTool('bash')).toBeNull()
    expect(operationForTool('todo')).toBeNull()
    expect(operationForTool('web_search')).toBeNull()
  })

  it('finds the path argument whatever it is called', () => {
    expect(pathFromArgs({ path: 'a.ts' })).toBe('a.ts')
    expect(pathFromArgs({ file_path: 'b.ts' })).toBe('b.ts')
    expect(pathFromArgs({ target: 'c.ts' })).toBe('c.ts')
    expect(pathFromArgs({ pattern: 'x' })).toBeNull()
    expect(pathFromArgs(null)).toBeNull()
  })

  it('records a finished call', () => {
    const e = eventFromTool(
      { callId: 'c1', name: 'write', args: { path: 'src/a.ts' }, diff: '@@' },
      3,
      100,
      projectOrigin
    )
    expect(e).toMatchObject({
      path: 'src/a.ts',
      operation: 'write',
      toolCallId: 'c1',
      ok: true,
      hasDiff: true,
    })
  })

  it('ignores a call still running, which has not done anything yet', () => {
    expect(
      eventFromTool(
        { callId: 'c1', name: 'write', args: { path: 'a.ts' }, status: 'running' },
        0,
        0,
        projectOrigin
      )
    ).toBeNull()
  })

  it('records a failure as activity, because an attempt happened', () => {
    const e = eventFromTool(
      { callId: 'c2', name: 'read', args: { path: 'gone.ts' }, isError: true },
      0,
      0,
      projectOrigin
    )
    expect(e?.ok).toBe(false)
  })

  it('never invents a row from a tool with no path', () => {
    expect(
      eventFromTool({ callId: 'c', name: 'read', args: {} }, 0, 0, projectOrigin)
    ).toBeNull()
  })
})

describe('normalizing paths', () => {
  it('unifies Windows separators so one file is one row', () => {
    expect(normalizePath('src\\lib\\a.ts')).toBe('src/lib/a.ts')
  })

  it('drops redundant segments and trailing slashes', () => {
    expect(normalizePath('./src//a.ts')).toBe('src/a.ts')
    expect(normalizePath('src/lib/')).toBe('src/lib')
  })

  it('keeps an absolute path absolute', () => {
    expect(normalizePath('/home/u/a.ts')).toBe('/home/u/a.ts')
  })

  it('leaves .. alone, because containment is not a display decision', () => {
    // Collapsing here would let a traversal render as a contained path.
    expect(normalizePath('src/../../etc/passwd')).toBe('src/../../etc/passwd')
  })
})

describe('grouping', () => {
  const events = [
    event({ id: '1', path: 'src/a.ts', operation: 'read', at: 1 }),
    event({ id: '2', path: 'src/a.ts', operation: 'write', at: 5 }),
    event({ id: '3', path: 'src/b.ts', operation: 'read', at: 3 }),
  ]

  it('collects a file’s events together, most recent file first', () => {
    const groups = groupByFile(events)
    expect(groups.map((g) => g.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(groups[0].events).toHaveLength(2)
    expect(groups[0].lastAt).toBe(5)
  })

  it('marks a file that was changed, and one that was not', () => {
    const groups = groupByFile(events)
    expect(groups[0].changed).toBe(true)
    expect(groups[1].changed).toBe(false)
  })

  it('filters by path', () => {
    expect(groupByFile(events, { search: 'b.ts' }).map((g) => g.path)).toEqual([
      'src/b.ts',
    ])
  })

  it('filters to changes only', () => {
    const groups = groupByFile(events, { filter: 'changed' })
    expect(groups).toHaveLength(1)
    expect(groups[0].events).toHaveLength(1)
  })
})

describe('the filters', () => {
  it('separate looking from changing', () => {
    expect(matchesFilter(event({ operation: 'read' }), 'read')).toBe(true)
    expect(matchesFilter(event({ operation: 'list' }), 'read')).toBe(true)
    expect(matchesFilter(event({ operation: 'write' }), 'read')).toBe(false)
    expect(matchesFilter(event({ operation: 'write' }), 'changed')).toBe(true)
  })

  it('separate the roots', () => {
    expect(matchesFilter(event({ origin: 'project' }), 'project')).toBe(true)
    expect(matchesFilter(event({ origin: 'sandbox' }), 'project')).toBe(false)
    expect(matchesFilter(event({ origin: 'sandbox' }), 'sandbox')).toBe(true)
  })

  it('surface failures whatever they were', () => {
    expect(matchesFilter(event({ ok: false, operation: 'read' }), 'failed')).toBe(
      true
    )
    expect(matchesFilter(event({ ok: true }), 'failed')).toBe(false)
  })

  it('count what each would show', () => {
    const counts = countsByFilter([
      event({ id: '1', operation: 'read' }),
      event({ id: '2', operation: 'write' }),
      event({ id: '3', operation: 'read', ok: false }),
    ])
    expect(counts.all).toBe(3)
    expect(counts.read).toBe(2)
    expect(counts.changed).toBe(1)
    expect(counts.failed).toBe(1)
  })
})

describe('older conversations', () => {
  it('derive only from structured tool rows', () => {
    const derived = deriveFromTurns(
      [
        { name: 'read', args: { path: 'a.ts' }, callId: 'c1' },
        // Prose is not evidence; there is no tool row here to believe.
        { name: undefined, args: undefined },
        { name: 'bash', args: { command: 'rm -rf /' } },
        { name: 'write', args: { path: 'b.ts' }, callId: 'c2' },
      ],
      projectOrigin
    )
    expect(derived.map((e) => e.path)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('merging', () => {
  it('does not record the same call twice', () => {
    const first = [event({ id: 'a' })]
    expect(mergeEvents(first, [event({ id: 'a' })])).toHaveLength(1)
    expect(mergeEvents(first, [event({ id: 'b' })])).toHaveLength(2)
  })

  it('returns the same array when nothing is new, so renders can skip', () => {
    const first = [event({ id: 'a' })]
    expect(mergeEvents(first, [event({ id: 'a' })])).toBe(first)
  })
})

describe('change classification', () => {
  it('knows which operations touched the file', () => {
    for (const op of ['write', 'edit', 'create', 'delete', 'rename'] as const) {
      expect(isChange(op)).toBe(true)
    }
    for (const op of ['read', 'list', 'search'] as const) {
      expect(isChange(op)).toBe(false)
    }
  })
})
