import { describe, it, expect } from 'vitest'
import {
  backgroundJobId,
  buildTaskList,
  commandTasks,
  countToolCalls,
  elapsedMs,
  mergeTasks,
  sortTasks,
  subagentTasks,
  taskTotals,
  totalTokens,
  type TaskRow,
} from '@/lib/coworkTasks'
import type { CoworkTurn, SubagentRun } from '@/types/coworkSession'

const run = (over: Partial<SubagentRun> = {}): SubagentRun => ({
  runId: 'r1',
  name: 'researcher',
  status: 'done',
  startedAt: 1_000,
  endedAt: 3_000,
  turns: [],
  ...over,
})

const toolTurn = (over: Partial<CoworkTurn> = {}): CoworkTurn => ({
  role: 'tool',
  content: '',
  name: 'bash',
  callId: 'c1',
  status: 'done',
  ...over,
})

describe('backgroundJobId', () => {
  it('recovers the id from the tool’s background marker', () => {
    const text =
      'Command exceeded 30s and is continuing in the background (job_id=bash-7). ' +
      'Call bash again with {"job_id": "bash-7"} (no command) to collect its output.'
    expect(backgroundJobId(text)).toBe('bash-7')
  })

  it('returns null for output that never backgrounded', () => {
    expect(backgroundJobId('total 24\ndrwxr-xr-x  4 joel staff')).toBeNull()
    expect(backgroundJobId('')).toBeNull()
    expect(backgroundJobId(undefined)).toBeNull()
    expect(backgroundJobId(42)).toBeNull()
  })
})

describe('subagentTasks', () => {
  it('carries status, timing, usage, queue position and transcript across', () => {
    const rows = subagentTasks([
      run({
        runId: 'r1',
        name: 'reviewer',
        status: 'running',
        startedAt: 500,
        endedAt: undefined,
        usage: { total_tokens: 1234 },
        turns: [
          toolTurn(),
          toolTurn({ callId: 'c2' }),
          { role: 'assistant', content: 'hi' },
        ],
        finalOutput: 'done looking',
      }),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'r1',
      kind: 'subagent',
      title: 'reviewer',
      status: 'running',
      startedAt: 500,
      toolCount: 2,
      output: 'done looking',
    })
    expect(rows[0].usage?.total_tokens).toBe(1234)
    expect(rows[0].transcript).toHaveLength(3)
  })

  it('keeps the queue position while queued', () => {
    const [row] = subagentTasks([run({ status: 'queued', waiting: 3 })])
    expect(row.status).toBe('queued')
    expect(row.waiting).toBe(3)
  })

  it('handles an absent lane', () => {
    expect(subagentTasks(undefined)).toEqual([])
  })
})

describe('commandTasks', () => {
  it('lists bash calls with their command line', () => {
    const rows = commandTasks([
      toolTurn({ args: { command: 'yarn test' }, result: 'ok' }),
      { role: 'assistant', content: 'thinking' },
    ])
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'c1',
        kind: 'command',
        title: 'yarn test',
        status: 'done',
        output: 'ok',
      }),
    ])
  })

  it('ignores tool calls that are not shell commands', () => {
    expect(
      commandTasks([toolTurn({ name: 'read', args: { path: 'a.ts' } })])
    ).toEqual([])
  })

  it('reports a still-running call as running', () => {
    const [row] = commandTasks([
      toolTurn({ status: 'running', args: { command: 'sleep 60' } }),
    ])
    expect(row.status).toBe('running')
  })

  it('treats a backgrounded command as still running, and keeps its job id', () => {
    // The tool call returned, but the shell did not: reporting this as "done"
    // would tell the user a command finished while it is still going.
    const [row] = commandTasks([
      toolTurn({
        args: { command: 'cargo build --release' },
        result:
          'Command exceeded 30s and is continuing in the background (job_id=bash-2).',
      }),
    ])
    expect(row.status).toBe('running')
    expect(row.jobId).toBe('bash-2')
  })

  it('marks a failed command as an error', () => {
    const [row] = commandTasks([
      toolTurn({ args: { command: 'false' }, isError: true, result: 'exit 1' }),
    ])
    expect(row.status).toBe('error')
  })

  it('still lists a call whose arguments have not finished streaming', () => {
    const [row] = commandTasks([
      toolTurn({ args: undefined, argsLive: '{"comm', status: 'running' }),
    ])
    expect(row.title).toBe('…')
    expect(row.status).toBe('running')
  })

  it('falls back to a positional id when the call has none', () => {
    const [row] = commandTasks([
      toolTurn({ callId: undefined, args: { command: 'ls' } }),
    ])
    expect(row.id).toBe('bash-0')
  })
})

describe('counting and totals', () => {
  it('counts only tool turns', () => {
    expect(
      countToolCalls([
        toolTurn(),
        { role: 'assistant', content: 'x' },
        toolTurn({ callId: 'c2' }),
      ])
    ).toBe(2)
    expect(countToolCalls(undefined)).toBe(0)
  })

  it('sums tokens across rows that report usage', () => {
    const rows: TaskRow[] = [
      {
        id: 'a',
        kind: 'subagent',
        title: 'a',
        status: 'done',
        usage: { total_tokens: 10 },
      },
      { id: 'b', kind: 'subagent', title: 'b', status: 'done', usage: {} },
      { id: 'c', kind: 'command', title: 'ls', status: 'done' },
    ]
    expect(totalTokens(rows)).toBe(10)
  })

  it('aggregates a run at a glance', () => {
    const totals = taskTotals([
      {
        id: 'a',
        kind: 'subagent',
        title: 'a',
        status: 'running',
        toolCount: 3,
        usage: { total_tokens: 100 },
      },
      { id: 'b', kind: 'subagent', title: 'b', status: 'queued', waiting: 1 },
      {
        id: 'c',
        kind: 'subagent',
        title: 'c',
        status: 'done',
        toolCount: 2,
        usage: { total_tokens: 50 },
      },
      { id: 'd', kind: 'command', title: 'false', status: 'error' },
    ])
    expect(totals).toEqual({
      running: 1,
      queued: 1,
      finished: 2,
      tokens: 150,
      toolCalls: 5,
    })
  })
})

describe('elapsedMs', () => {
  it('measures a finished row between its own timestamps', () => {
    const row: TaskRow = {
      id: 'a',
      kind: 'subagent',
      title: 'a',
      status: 'done',
      startedAt: 1_000,
      endedAt: 4_500,
    }
    expect(elapsedMs(row, 9_999)).toBe(3_500)
  })

  it('measures a running row up to now', () => {
    const row: TaskRow = {
      id: 'a',
      kind: 'subagent',
      title: 'a',
      status: 'running',
      startedAt: 1_000,
    }
    expect(elapsedMs(row, 3_000)).toBe(2_000)
  })

  it('never reports a negative duration', () => {
    const row: TaskRow = {
      id: 'a',
      kind: 'subagent',
      title: 'a',
      status: 'running',
      startedAt: 5_000,
    }
    expect(elapsedMs(row, 1_000)).toBe(0)
  })

  it('is undefined for a row with no start time', () => {
    expect(
      elapsedMs({ id: 'a', kind: 'command', title: 'ls', status: 'done' }, 1)
    ).toBeUndefined()
  })
})

describe('sortTasks', () => {
  it('puts running first, then the queue in position order, then finished newest-first', () => {
    const rows: TaskRow[] = [
      {
        id: 'done-old',
        kind: 'subagent',
        title: 'old',
        status: 'done',
        endedAt: 100,
      },
      {
        id: 'queued-2',
        kind: 'subagent',
        title: 'q2',
        status: 'queued',
        waiting: 2,
      },
      {
        id: 'running',
        kind: 'subagent',
        title: 'r',
        status: 'running',
        startedAt: 50,
      },
      {
        id: 'done-new',
        kind: 'subagent',
        title: 'new',
        status: 'done',
        endedAt: 900,
      },
      {
        id: 'queued-1',
        kind: 'subagent',
        title: 'q1',
        status: 'queued',
        waiting: 1,
      },
    ]
    expect(sortTasks(rows).map((r) => r.id)).toEqual([
      'running',
      'queued-1',
      'queued-2',
      'done-new',
      'done-old',
    ])
  })

  it('does not mutate its input', () => {
    const rows: TaskRow[] = [
      { id: 'a', kind: 'subagent', title: 'a', status: 'done', endedAt: 1 },
      { id: 'b', kind: 'subagent', title: 'b', status: 'running' },
    ]
    const before = rows.map((r) => r.id)
    sortTasks(rows)
    expect(rows.map((r) => r.id)).toEqual(before)
  })
})

describe('mergeTasks', () => {
  it('prefers the live copy of a run that appears in both lanes', () => {
    const live: TaskRow[] = [
      { id: 'r1', kind: 'subagent', title: 'r', status: 'running' },
    ]
    const committed: TaskRow[] = [
      { id: 'r1', kind: 'subagent', title: 'r', status: 'done' },
      { id: 'r0', kind: 'subagent', title: 'earlier', status: 'done' },
    ]
    const merged = mergeTasks(live, committed)
    expect(merged).toHaveLength(2)
    expect(merged.find((r) => r.id === 'r1')?.status).toBe('running')
    expect(merged.find((r) => r.id === 'r0')).toBeTruthy()
  })
})

describe('buildTaskList', () => {
  it('combines both lanes with shell commands, in display order', () => {
    const rows = buildTaskList({
      liveSubagents: [
        run({
          runId: 'live',
          name: 'live-agent',
          status: 'running',
          startedAt: 10,
          endedAt: undefined,
        }),
      ],
      sessionSubagents: [
        run({ runId: 'old', name: 'old-agent', status: 'done', endedAt: 5 }),
      ],
      turns: [toolTurn({ callId: 'cmd', args: { command: 'ls -la' } })],
    })

    expect(rows.map((r) => r.id)).toEqual(['live', 'old', 'cmd'])
    expect(rows[0].status).toBe('running')
    expect(rows[2].kind).toBe('command')
  })

  it('survives a session with nothing in it', () => {
    expect(buildTaskList({})).toEqual([])
  })

  it('keeps finished work after the live lane is reset', () => {
    // A finished run empties the run store's lane; the committed session is
    // what keeps the history from vanishing.
    const rows = buildTaskList({
      liveSubagents: [],
      sessionSubagents: [run({ runId: 'r1', status: 'done' })],
    })
    expect(rows.map((r) => r.id)).toEqual(['r1'])
  })
})
