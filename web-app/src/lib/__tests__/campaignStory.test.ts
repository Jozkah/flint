import { describe, it, expect } from 'vitest'
import {
  campaignElapsedMs,
  effortPercent,
  failuresOf,
  formatDuration,
  groupSteps,
  headlineOf,
  lastFailure,
  nextStepOf,
  planLevels,
  shortBrief,
  stepsOf,
  taskDurationMs,
} from '../campaignStory'
import type { ToolActivityItem } from '../toolActivity'
import type { CampaignTask } from '../campaignModel'

const item = (over: Partial<ToolActivityItem>): ToolActivityItem =>
  ({
    call: 'c',
    tool: 'read',
    session: 's',
    run: 'r',
    invocation: 'i',
    agent: 'a',
    resource: '',
    summary: '',
    phase: 'succeeded',
    requested_at: '',
    elapsed_ms: 0,
    exit_code: null,
    detail: '',
    history: [],
    ...over,
  }) as ToolActivityItem

describe('stepsOf', () => {
  it('keeps reads, writes and commands in order and marks failures with their error', () => {
    const steps = stepsOf([
      item({ tool: 'bash', summary: 'npm test', phase: 'failed', exit_code: 1, output: 'boom', requested_at_ms: 3 }),
      item({ tool: 'read', summary: 'a.ts', requested_at_ms: 1 }),
      item({ tool: 'write', summary: 'b.ts', requested_at_ms: 2 }),
      item({ tool: 'todo', summary: 'x', requested_at_ms: 4 }),
      item({ tool: 'bash', summary: 'still going', phase: 'running', requested_at_ms: 5 }),
    ])
    expect(steps.map((s) => [s.kind, s.label, s.ok])).toEqual([
      ['read', 'a.ts', true],
      ['write', 'b.ts', true],
      ['command', 'npm test', false],
    ])
    expect(lastFailure(steps)?.error).toBe('boom')
    expect(failuresOf(steps)).toBe(1)
  })

  it('treats a nonzero exit code as a failure even when the call itself succeeded', () => {
    const [s] = stepsOf([item({ tool: 'bash', summary: 'make', exit_code: 2 })])
    expect(s.ok).toBe(false)
  })

  it('degrades to nothing without a record', () => {
    expect(stepsOf(undefined)).toEqual([])
  })
})

describe('groupSteps', () => {
  it('folds runs of the same kind and keeps failures on their own', () => {
    const g = groupSteps([
      { kind: 'read', label: 'a', ok: true },
      { kind: 'read', label: 'b', ok: true },
      { kind: 'command', label: 'x', ok: false },
      { kind: 'command', label: 'x', ok: false },
    ])
    expect(g.map((x) => [x.kind, x.steps.length])).toEqual([
      ['read', 2],
      ['command', 1],
      ['command', 1],
    ])
  })
})

describe('headlineOf', () => {
  const story = (over = {}) => ({
    files: 4,
    added: 176,
    removed: 0,
    counted: true,
    steps: [] as { kind: 'command'; label: string; ok: boolean }[],
    ...over,
  })
  const t = (status: CampaignTask['status']) => ({ status, dependsOn: [] as string[] })
  it('says what was written when finished', () => {
    expect(headlineOf(t('merged'), [], story()).kind).toBe('wrote')
    expect(headlineOf(t('verified'), [], story({ files: 0 })).kind).toBe('finishedNoFiles')
  })
  it('says where a failed task stopped', () => {
    const failing = [
      { kind: 'command' as const, label: 'sh', ok: false },
      { kind: 'command' as const, label: 'sh', ok: false },
      { kind: 'command' as const, label: 'sh', ok: false },
    ]
    const h = headlineOf(t('failed'), [], story({ steps: failing }))
    expect(h.kind).toBe('wroteStopped')
    expect(h.params.failures).toBe(3)
    expect(headlineOf(t('failed'), [], story({ files: 0, steps: failing })).kind).toBe('stoppedFailing')
    expect(headlineOf(t('failed'), [], story({ files: 0 })).kind).toBe('stoppedPlain')
  })
  it('names what a waiting task waits for', () => {
    const h = headlineOf(
      { status: 'pending', dependsOn: ['a'] },
      [{ id: 'a', status: 'running', title: 'Storage' }],
      story({ files: 0 })
    )
    expect(h.kind).toBe('waiting')
    expect(h.params.tasks).toBe('Storage')
  })
})

describe('nextStepOf', () => {
  it('recommends one action', () => {
    expect(nextStepOf({ status: 'failed', attempt: 0 }, true)).toBe('retry')
    expect(nextStepOf({ status: 'failed', attempt: 2 }, false)).toBe('open')
    expect(nextStepOf({ status: 'conflict', attempt: 0 }, true)).toBe('conflict')
    expect(nextStepOf({ status: 'awaiting_approval', attempt: 0 }, false)).toBe('approve')
    expect(nextStepOf({ status: 'running', attempt: 0 }, false)).toBeNull()
  })
})

describe('time', () => {
  const ev = [
    { ts: '2026-01-01T10:00:00Z', kind: 'task-status', task: 'a', detail: 'Queued -> Running' },
    { ts: '2026-01-01T10:03:00Z', kind: 'task-status', task: 'a', detail: 'Running -> Completed' },
  ]
  it('measures a finished task and a running one', () => {
    expect(taskDurationMs(ev, 'a', false, 0)).toBe(180_000)
    expect(taskDurationMs(ev.slice(0, 1), 'a', true, Date.parse('2026-01-01T10:01:00Z'))).toBe(60_000)
    expect(taskDurationMs(ev, 'zzz', false, 0)).toBeNull()
    expect(taskDurationMs(undefined, 'a', false, 0)).toBeNull()
  })
  it('counts the run, not verification or merge, even when other event kinds follow', () => {
    const log = [
      { ts: '2026-01-01T10:00:00Z', kind: 'task-status', task: 'a', detail: 'Queued -> Running' },
      { ts: '2026-01-01T10:04:00Z', kind: 'task-settled', task: 'a', detail: 'Running -> Completed' },
      { ts: '2026-01-01T10:04:01Z', kind: 'task-status', task: 'a', detail: 'Completed -> Verifying' },
      { ts: '2026-01-01T10:09:00Z', kind: 'task-verified', task: 'a', detail: 'PASS: ok' },
      { ts: '2026-01-01T10:09:30Z', kind: 'task-merged', task: 'a', detail: 'merged' },
    ]
    expect(taskDurationMs(log, 'a', false, 0)).toBe(240_000)
  })
  it('adds a second run after a repair and never reports a settled task as 1 s', () => {
    const log = [
      { ts: '2026-01-01T10:00:00Z', kind: 'task-status', task: 'a', detail: 'Queued -> Running' },
      { ts: '2026-01-01T10:02:00Z', kind: 'task-settled', task: 'a', detail: 'Running -> Completed' },
      { ts: '2026-01-01T10:05:00Z', kind: 'task-status', task: 'a', detail: 'Queued -> Running' },
      { ts: '2026-01-01T10:06:00Z', kind: 'task-settled', task: 'a', detail: 'Running -> Completed' },
    ]
    expect(taskDurationMs(log, 'a', false, 0)).toBe(180_000)
  })
  it('formats plainly', () => {
    expect(formatDuration(500)).toBe('1 s')
    expect(formatDuration(45_000)).toBe('45 s')
    expect(formatDuration(180_000)).toBe('3 min')
    expect(formatDuration(3_900_000)).toBe('1 h 05 min')
  })
  it('measures the campaign', () => {
    expect(
      campaignElapsedMs(
        { createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:10:00Z', status: 'done' },
        0
      )
    ).toBe(600_000)
  })
})

describe('effort and plan', () => {
  it('moves while tasks run', () => {
    const tasks = [
      { id: 'a', status: 'merged', dependsOn: [] },
      { id: 'b', status: 'running', dependsOn: [] },
      { id: 'c', status: 'pending', dependsOn: [] },
      { id: 'd', status: 'pending', dependsOn: [] },
    ] as Pick<CampaignTask, 'id' | 'status' | 'dependsOn'>[]
    expect(effortPercent(tasks)).toBe(34)
    expect(effortPercent([])).toBe(0)
  })
  it('layers the plan by dependency and survives a cycle', () => {
    const levels = planLevels([
      { id: 'a', title: 'A', dependsOn: [] },
      { id: 'b', title: 'B', dependsOn: [] },
      { id: 'c', title: 'C', dependsOn: ['a', 'b'] },
    ])
    expect(levels.map((l) => l.tasks.map((x) => x.id))).toEqual([['a', 'b'], ['c']])
    expect(levels[1].tasks[0].waitsFor).toEqual(['A', 'B'])
    expect(() =>
      planLevels([
        { id: 'a', title: 'A', dependsOn: ['b'] },
        { id: 'b', title: 'B', dependsOn: ['a'] },
      ])
    ).not.toThrow()
  })
  it('shortens a brief', () => {
    expect(shortBrief('word '.repeat(300), 20).endsWith('…')).toBe(true)
  })
})
