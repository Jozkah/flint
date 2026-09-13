import { describe, it, expect, vi } from 'vitest'
import type { EventEnvelope } from '@/lib/eventLog'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import {
  clampStep,
  listFinishedRuns,
  loadRunRecording,
  rowChangedAt,
  rowsAtStep,
} from '@/lib/runReplay'

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

const recording = () => {
  seq = 0
  return [
    env('run.started', { model: 'm' }),
    env('tool.requested', { call: 'c1', tool: 'read', phase: 'requested', agent: 'main' }),
    env('tool.running', { call: 'c1', tool: 'read', phase: 'running', agent: 'main' }),
    env('tool.succeeded', { call: 'c1', tool: 'read', phase: 'succeeded', agent: 'main' }),
    env('run.ended', { stoppedBy: 'done' }),
  ]
}

describe('runReplay', () => {
  it('shows the timeline as it stood after each step, not as it ended', () => {
    const events = recording()
    expect(rowsAtStep(events, 1, 's1').map((r) => r.title)).toEqual(['Run started'])
    const atRunning = rowsAtStep(events, 3, 's1')
    expect(atRunning).toHaveLength(2)
    expect(atRunning[1].status).toBe('running')
    const atEnd = rowsAtStep(events, 5, 's1')
    expect(atEnd.map((r) => r.status)).toEqual(['completed', 'completed', 'completed'])
  })

  it('names the row each step created or changed', () => {
    const events = recording()
    const first = rowChangedAt(events, 1, 's1')
    expect(first).toBe(rowsAtStep(events, 1, 's1')[0].id)
    const call = rowsAtStep(events, 2, 's1')[1].id
    // Requested, running and succeeded all change the same call's row.
    expect(rowChangedAt(events, 2, 's1')).toBe(call)
    expect(rowChangedAt(events, 3, 's1')).toBe(call)
    expect(rowChangedAt(events, 4, 's1')).toBe(call)
    expect(rowChangedAt(events, 5, 's1')).toBe(rowsAtStep(events, 5, 's1')[2].id)
    expect(rowChangedAt([], 1, 's1')).toBeUndefined()
  })

  it('keeps a step inside the recording', () => {
    expect(clampStep(0, 5)).toBe(1)
    expect(clampStep(9, 5)).toBe(5)
    expect(clampStep(2.7, 5)).toBe(2)
    expect(clampStep(3, 0)).toBe(0)
  })

  it('returns the backend refusal by kind and never throws', async () => {
    const refuse = vi.fn(async () => {
      throw { kind: 'invalid_input', message: 'run r2 has no recorded end', stage: 'replay' }
    })
    const loaded = await loadRunRecording('s1', 'r2', refuse)
    expect(loaded).toEqual({
      ok: false,
      error: { kind: 'invalid_input', message: 'run r2 has no recorded end' },
    })
    expect(refuse).toHaveBeenCalledWith('agent_events_run', { session: 's1', run: 'r2' })

    const broken = await listFinishedRuns('s1', async () => {
      throw new Error('ipc gone')
    })
    expect(broken).toEqual({ ok: false, error: { kind: 'internal', message: 'ipc gone' } })

    const ok = await listFinishedRuns('s1', async () => [{ run: 'r1', steps: 5 }])
    expect(ok.ok && ok.value[0].run).toBe('r1')
  })
})
