import { describe, it, expect } from 'vitest'
import type { EventEnvelope } from '@/lib/eventLog'
import { buildTimeline, resourcesOf } from '@/lib/executionTimeline'
import { formatBytes } from '@/containers/CoworkTimelinePanel'

let seq = 0
const env = (kind: string, payload: Record<string, unknown>): EventEnvelope => ({
  v: 1,
  id: `${kind}:${++seq}`,
  session: 's1',
  run: 'r1',
  invocation: 'inv-1',
  seq,
  at: '2026-09-13T10:00:00Z',
  kind,
  payload,
  redactions: [],
})

describe('timeline resources (AH-174)', () => {
  it('puts a command call’s measured figures on its row and the run’s totals on its end', () => {
    seq = 0
    const rows = buildTimeline(
      [
        env('run.started', {}),
        env('tool.requested', { call: 'c1', tool: 'bash', phase: 'requested' }),
        env('tool.succeeded', {
          call: 'c1',
          tool: 'bash',
          phase: 'succeeded',
          exit_code: 0,
          resources: { measured: true, cpuMs: 812, peakMemoryBytes: 52_428_800, processes: 3 },
        }),
        env('run.ended', {
          stoppedBy: 'done',
          resources: { commands: 2, measuredCommands: 1, cpuMs: 812, peakMemoryBytes: 52_428_800, processes: 3, unmeasuredReason: 'no job' },
        }),
      ],
      's1'
    )
    const call = rows.find((r) => r.call === 'c1')!
    expect(call.resources).toEqual({ measured: true, cpuMs: 812, peakMemoryBytes: 52_428_800, processes: 3, reason: undefined })
    const ended = rows.find((r) => r.title === 'Run ended')!
    expect(ended.resources).toMatchObject({ measured: true, cpuMs: 812, commands: 2, measuredCommands: 1, reason: 'no job' })
  })

  it('never turns an unmeasured command into zeros', () => {
    expect(resourcesOf({ measured: false, reason: 'measured on Windows only' })).toEqual({
      measured: false,
      cpuMs: undefined,
      peakMemoryBytes: undefined,
      processes: undefined,
      reason: 'measured on Windows only',
    })
    const run = resourcesOf({ commands: 1, measuredCommands: 0, cpuMs: 0, peakMemoryBytes: 0, processes: 0, unmeasuredReason: 'x' })!
    expect(run.measured).toBe(false)
    expect(run.cpuMs).toBeUndefined()
    expect(resourcesOf(null)).toBeUndefined()
    expect(resourcesOf({ cpuMs: 3 })).toBeUndefined()
  })

  it('formats bytes the way a person reads them', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(52_428_800)).toBe('50 MB')
  })
})
