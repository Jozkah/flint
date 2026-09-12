import { describe, it, expect } from 'vitest'
import type { EventEnvelope } from '@/lib/eventLog'
import {
  buildTimeline,
  countByCategory,
  filterTimeline,
  isTerminal,
  statusOfPhase,
  TIMELINE_CATEGORIES,
} from '@/lib/executionTimeline'
import { cacheStatus } from '@/lib/tokenUsage'

let seq = 0
const env = (
  kind: string,
  payload: Record<string, unknown>,
  over: Partial<EventEnvelope> = {}
): EventEnvelope => ({
  v: 1,
  id: `${kind}:${++seq}`,
  session: 's1',
  run: 'r1',
  invocation: '',
  seq,
  at: '2026-09-11T10:00:00Z',
  kind,
  payload,
  redactions: [],
  ...over,
})
const tool = (phase: string, call: string, extra: Record<string, unknown> = {}, over: Partial<EventEnvelope> = {}) =>
  env(`tool.${phase}`, { call, tool: 'read', phase, agent: 'main', ...extra }, over)

describe('buildTimeline', () => {
  it('folds a call into one row that moves through its phases, in log order', () => {
    seq = 0
    const rows = buildTimeline(
      [
        tool('requested', 'c1', { summary: 'a.txt' }, { invocation: 'inv-1' }),
        tool('requested', 'c2', { tool: 'ls' }),
        tool('running', 'c1'),
        tool('succeeded', 'c2', { tool: 'ls' }),
        tool('succeeded', 'c1', { elapsed_ms: 12, output: 'hello' }),
      ],
      's1'
    )
    expect(rows.map((r) => r.call)).toEqual(['c1', 'c2'])
    expect(rows[0]).toMatchObject({
      status: 'completed',
      history: ['requested', 'running', 'succeeded'],
      elapsedMs: 12,
      output: 'hello',
      invocation: 'inv-1',
    })
  })

  // AH-004: a provider that numbers its tool calls per request sends `call_1`
  // again on the next one. Two requests are two calls.
  it('keeps one call id used by two invocations as two rows', () => {
    seq = 0
    const rows = buildTimeline(
      [
        tool('requested', 'call_1', { summary: 'first.txt' }, { invocation: 'inv-1' }),
        tool('succeeded', 'call_1', { output: 'the first file' }, { invocation: 'inv-1' }),
        tool('requested', 'call_1', { summary: 'second.txt' }, { invocation: 'inv-2' }),
      ],
      's1'
    )
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.invocation)).toEqual(['inv-1', 'inv-2'])
    expect(rows[0].status).toBe('completed')
    expect(rows[0].output).toBe('the first file')
    expect(rows[1].status).toBe('running')
    expect(rows[1].output).toBeUndefined()
  })

  it('keeps every state apart: running, failed, refused, cancelled, interrupted', () => {
    expect(['requested', 'running', 'allowed'].map(statusOfPhase)).toEqual(['running', 'running', 'running'])
    expect(statusOfPhase('failed')).toBe('failed')
    expect(statusOfPhase('timed-out')).toBe('failed')
    expect(statusOfPhase('refused')).toBe('refused')
    expect(statusOfPhase('cancelled')).toBe('cancelled')
    expect(statusOfPhase('stale')).toBe('interrupted')
    expect(statusOfPhase('awaiting-permission')).toBe('awaiting')
    expect(isTerminal('awaiting')).toBe(false)
    expect(isTerminal('interrupted')).toBe(true)
  })

  it('never shows another session\'s events', () => {
    seq = 0
    const rows = buildTimeline(
      [tool('requested', 'c1'), tool('requested', 'c1', {}, { session: 's2' })],
      's1'
    )
    expect(rows).toHaveLength(1)
  })

  it('two agents reusing a provider call id stay two rows', () => {
    seq = 0
    const rows = buildTimeline(
      [
        tool('succeeded', 'call_0', { agent: 'explorer' }),
        tool('succeeded', 'call_0', { agent: 'reviewer' }),
      ],
      's1'
    )
    expect(rows.map((r) => r.agent)).toEqual(['explorer', 'reviewer'])
  })

  it('categorizes edits, approvals, refusals, steering, subagents and background work', () => {
    seq = 0
    const rows = buildTimeline(
      [
        tool('awaiting-permission', 'e1', { tool: 'edit' }),
        tool('succeeded', 'e1', {
          tool: 'edit',
          change: { path: 'a.ts', kind: 'edited', added: 2, removed: 1, diffStored: true, oversized: false },
        }),
        tool('refused', 'w1', { tool: 'write', refusal: 'tool-not-offered' }),
        env('lifecycle.succeeded', { call: 'steer:1', lifecycle: 'steering', phase: 'succeeded', tool: 'steering' }),
        env('lifecycle.cancelled', { call: 'stop:1', lifecycle: 'subagent', phase: 'cancelled', tool: 'subagent' }),
        tool('succeeded', 'b1', { tool: 'bash', job_id: 'bash-1' }),
        env('agent.dispatched', { agent: 'explorer' }),
        env('job.started', { tool: 'bash' }),
      ],
      's1'
    )
    const by = (call: string) => rows.find((r) => r.call === call)!
    expect(by('e1').categories).toEqual(expect.arrayContaining(['tools', 'edits', 'approvals']))
    expect(by('e1').change).toMatchObject({ added: 2, removed: 1, diffStored: true })
    expect(by('w1')).toMatchObject({ status: 'refused', refusal: 'tool-not-offered' })
    expect(by('steer:1').categories).toEqual(['steering'])
    expect(by('stop:1')).toMatchObject({ status: 'cancelled', categories: ['subagents'] })
    expect(by('b1').categories).toContain('background')
    const counts = countByCategory(rows)
    expect(counts.subagents).toBe(2)
    expect(counts.background).toBe(2)
  })

  it('turns usage and response events into their own rows, linked by invocation', () => {
    seq = 0
    const rows = buildTimeline(
      [
        env('run.started', { model: 'm' }),
        env('usage.reported', { inputTokens: 1000, cachedTokens: 900, outputTokens: 5, cacheReportedRequests: 1, cacheHitRequests: 1 }, { invocation: 'inv-9' }),
        env('message.completed', { textChars: 12, reasoningChars: 40, toolCalls: 1 }, { invocation: 'inv-9' }),
        tool('requested', 'c1', {}, { invocation: 'inv-9' }),
        env('run.ended', { stoppedBy: 'aborted' }),
      ],
      's1'
    )
    const usage = rows.find((r) => r.primary === 'usage')!
    expect(cacheStatus(usage.usage)).toBe('reused')
    expect(usage.usage?.uncachedInputTokens).toBe(100)
    const msg = rows.find((r) => r.primary === 'messages')!
    expect(msg.categories).toEqual(['messages', 'reasoning'])
    expect(rows.filter((r) => r.invocation === 'inv-9')).toHaveLength(3)
    expect(rows.at(-1)).toMatchObject({ title: 'Run ended', status: 'cancelled' })
  })

  it('says what kind of failure a call was, and never invents one', () => {
    seq = 0
    const rows = buildTimeline(
      [
        env('tool.requested', { call: 'c1', tool: 'read' }, { invocation: 'inv-1' }),
        env(
          'tool.failed',
          { call: 'c1', tool: 'read', error_kind: 'sandbox_denied', detail: 'outside the workspace' },
          { invocation: 'inv-1' }
        ),
        env('tool.requested', { call: 'c2', tool: 'bash' }, { invocation: 'inv-1' }),
        // A row recorded before the taxonomy reached the tool layer.
        env('tool.failed', { call: 'c2', tool: 'bash', detail: 'it went wrong' }, { invocation: 'inv-1' }),
      ],
      's1'
    )
    const denied = rows.find((r) => r.tool === 'read')!
    expect(denied.status).toBe('failed')
    expect(denied.errorKind).toBe('sandbox_denied')
    const legacy = rows.find((r) => r.tool === 'bash')!
    expect(legacy.status).toBe('failed')
    expect(legacy.errorKind).toBeUndefined()
  })

  it('shows a provider fall-back as something that happened', () => {
    seq = 0
    const rows = buildTimeline(
      [
        env('message.completed', { phase: 'dispatched', snapshotId: 'snap-1' }, { invocation: 'inv-1' }),
        env(
          'message.completed',
          { phase: 'fell-back', from: 'first/m', to: 'second/m', failureKind: 'transport', reason: 'error sending request' },
          { invocation: 'inv-2' }
        ),
        env('message.completed', { phase: 'completed', textChars: 10 }, { invocation: 'inv-2' }),
      ],
      's1'
    )
    const fallback = rows.find((r) => r.title === 'Provider fell back')!
    expect(fallback).toBeTruthy()
    expect(fallback.status).toBe('failed')
    expect(fallback.fallback).toMatchObject({ from: 'first/m', to: 'second/m', kind: 'transport' })
    expect(fallback.invocation).toBe('inv-2')
    // The reply that did arrive is still its own row.
    expect(rows.some((r) => r.title === 'Response')).toBe(true)
  })

  it('shows a request that never answered as a failure with its kind', () => {
    seq = 0
    const rows = buildTimeline(
      [
        env(
          'message.completed',
          { phase: 'failed', detail: 'the provider did not answer', error: { kind: 'transport', stage: 'dispatch' } },
          { invocation: 'inv-1' }
        ),
      ],
      's1'
    )
    expect(rows[0]).toMatchObject({ title: 'Request failed', status: 'failed', errorKind: 'transport' })
  })

  it('keeps a kind this build does not know, verbatim', () => {
    seq = 0
    const rows = buildTimeline([env('future.thing', { x: 1 })], 's1')
    expect(rows[0].title).toBe('future.thing')
  })
})

describe('filterTimeline', () => {
  it('shows a row when any of its categories is enabled', () => {
    seq = 0
    const rows = buildTimeline(
      [tool('succeeded', 'e1', { tool: 'edit' }), tool('succeeded', 'r1')],
      's1'
    )
    expect(filterTimeline(rows, new Set(['edits'])).map((r) => r.call)).toEqual(['e1'])
    expect(filterTimeline(rows, new Set(TIMELINE_CATEGORIES))).toHaveLength(2)
    expect(filterTimeline(rows, new Set())).toHaveLength(0)
  })
})
