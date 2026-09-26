/** AH-172: what the timeline shows after the record and the transcript meet. */
import { describe, expect, it } from 'vitest'
import { reconcileToolActivity } from '../coworkActivityTimeline'
import type { ToolActivityItem, ToolActivityPhase } from '../toolActivity'
import type { CoworkTurn } from '@/types/coworkSession'

const item = (
  call: string,
  phase: ToolActivityPhase,
  extra: Partial<ToolActivityItem> = {}
): ToolActivityItem => ({
  call,
  tool: 'read',
  session: 's1',
  run: 'r1',
  invocation: '',
  agent: 'main',
  resource: 'a.ts',
  summary: '',
  phase,
  requested_at: '2026-09-08T10:00:00Z',
  elapsed_ms: 12,
  exit_code: null,
  detail: '',
  history: ['requested', phase],
  ...extra,
})

const toolTurn = (call: string, over: Partial<CoworkTurn> = {}): CoworkTurn => ({
  role: 'tool',
  content: '',
  callId: call,
  name: 'read',
  result: 'file contents',
  status: 'running',
  toolState: 'running',
  ...over,
})

it('leaves a transcript alone when there is no record', () => {
  const turns = [toolTurn('c1')]
  expect(reconcileToolActivity(turns, [])).toBe(turns)
})

it('settles a call the transcript still believes is running', () => {
  const [turn] = reconcileToolActivity(
    [toolTurn('c1')],
    [item('c1', 'stale', { detail: 'did not survive a restart' })]
  )
  expect(turn.toolState).toBe('stale')
  expect(turn.status).toBe('done')
  // The tool's own output is kept: the record does not carry it.
  expect(turn.result).toBe('file contents')
})

it('keeps a call the record never heard of', () => {
  const turns = [toolTurn('c1'), toolTurn('c2')]
  const merged = reconcileToolActivity(turns, [item('c1', 'succeeded')])
  expect(merged).toHaveLength(2)
  expect(merged[1].callId).toBe('c2')
})

it('restores a call the transcript lost, in request order', () => {
  const merged = reconcileToolActivity(
    [{ role: 'user', content: 'go' }],
    [item('c1', 'succeeded'), item('c2', 'failed', { tool: 'bash' })]
  )
  expect(merged.map((t) => t.callId)).toEqual([undefined, 'c1', 'c2'])
  expect(merged[2]).toMatchObject({ name: 'bash', isError: true })
})

it('marks a refusal as an error the timeline cannot hide', () => {
  const [turn] = reconcileToolActivity(
    [toolTurn('c1', { name: 'bash' })],
    [item('c1', 'refused')]
  )
  expect(turn.toolState).toBe('refused')
  expect(turn.isError).toBe(true)
})

it('returns the same turn object when nothing changed', () => {
  const turns = [toolTurn('c1', { toolState: 'succeeded', isError: undefined })]
  const merged = reconcileToolActivity(turns, [item('c1', 'succeeded')])
  expect(merged[0]).toBe(turns[0])
})

it('shows a timed-out call as failed without losing why', () => {
  const [turn] = reconcileToolActivity(
    [toolTurn('c1', { result: undefined })],
    [item('c1', 'timed-out', { detail: 'no output for 120s' })]
  )
  expect(turn.toolState).toBe('failed')
  expect(turn.result).toBe('no output for 120s')
})

describe('lifecycle records are not tool calls', () => {
  // An earlier run's steering delivery stays in the session's record. It must
  // not become a "Used steering" call on a later, ordinary turn.
  const staleSteering = item('steer:old-run:q1', 'succeeded', {
    tool: 'steering',
    run: 'old-run',
    event_type: 'lifecycle',
    lifecycle: 'steering',
    resource: '',
    summary: 'Input delivered to the running agent',
  })

  it('does not append a stale steering record to a new turn', () => {
    const turns: CoworkTurn[] = [
      { role: 'user', content: 'trigger the build for me' },
      toolTurn('bash-1', { name: 'bash', runId: 'new-run' }),
    ]
    const out = reconcileToolActivity(turns, [
      staleSteering,
      item('bash-1', 'succeeded', { tool: 'bash', run: 'new-run' }),
    ])
    expect(out).toHaveLength(2)
    expect(out.some((t) => t.name === 'steering')).toBe(false)
    expect(out[1].toolState).toBe('succeeded')
  })

  it('leaves the transcript alone when the record holds only lifecycle rows', () => {
    const turns: CoworkTurn[] = [{ role: 'user', content: 'hi' }]
    expect(reconcileToolActivity(turns, [staleSteering])).toBe(turns)
  })
})
