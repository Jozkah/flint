/**
 * Chat's run and invocation identity (AH-004).
 *
 * What matters is that a turn is one run, every model request inside it is its
 * own invocation, and the events a turn produces all name the request that
 * caused them -- so a provider that reuses `call_1` every request cannot make
 * two calls look like one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { recordEvents } = vi.hoisted(() => ({ recordEvents: vi.fn(async () => {}) }))
vi.mock('@/lib/eventLog', () => ({ recordEvents }))

import {
  beginChatRun,
  chatAwaitsTools,
  continueOrBeginChatRun,
  markChatAwaitingTools,
  chatRunOf,
  endChatRun,
  nextChatInvocation,
  recordChatMessage,
  recordChatUsage,
  __testing,
  recordChatDispatch,
  chatSnapshotId,
} from '@/lib/chatRun'

const written = () => recordEvents.mock.calls.flatMap((c) => c[0] as { kind: string; run: string; invocation?: string; id: string; payload?: Record<string, unknown> }[])

beforeEach(() => {
  __testing.reset()
  recordEvents.mockClear()
})

describe('chatRun', () => {
  it('opens a turn, numbers its requests, and closes it once', () => {
    const { run } = beginChatRun('thread-1', { model: 'a-model' })
    expect(chatRunOf('thread-1')?.run).toBe(run)

    const first = nextChatInvocation('thread-1')
    recordChatUsage('thread-1', first, { inputTokens: 10 })
    const second = nextChatInvocation('thread-1')
    recordChatUsage('thread-1', second, { inputTokens: 20 })
    recordChatMessage('thread-1', second, { finishReason: 'stop' })
    endChatRun('thread-1', 'done')
    // A second end (an abort arriving after the finish) is not a second run.
    endChatRun('thread-1', 'cancelled')

    expect(first).not.toBe(second)
    const events = written()
    expect(events.map((e) => e.kind)).toEqual([
      'run.started',
      'usage.reported',
      'usage.reported',
      'message.completed',
      'run.ended',
    ])
    expect(events.every((e) => e.run === run)).toBe(true)
    expect(events[1].invocation).toBe(first)
    expect(events[2].invocation).toBe(second)
    expect(events[3].invocation).toBe(second)
    expect(events[0].payload).toMatchObject({ model: 'a-model', source: 'chat' })
    expect(events[4].payload).toMatchObject({ stoppedBy: 'done', steps: 2 })
    expect(chatRunOf('thread-1')).toBeUndefined()
  })

  // Chat runs its tools between requests, so the request that carries their
  // results back is the same turn, not a new one (AH-004).
  it('continues a turn whose reply asked for tools, and closes any other', () => {
    const first = continueOrBeginChatRun('t1', { model: 'm' })
    const firstStep = nextChatInvocation('t1')
    markChatAwaitingTools('t1', true)
    const second = continueOrBeginChatRun('t1', { model: 'm' })
    const secondStep = nextChatInvocation('t1')
    expect(second.run).toBe(first.run)
    expect(secondStep).not.toBe(firstStep)
    expect(chatAwaitsTools('t1')).toBe(false)
    endChatRun('t1', 'done')

    // A reply that needed no tools ends its turn; the next request is a new one.
    const a = continueOrBeginChatRun('t1', { model: 'm' })
    markChatAwaitingTools('t1', false)
    const b = continueOrBeginChatRun('t1', { model: 'm' })
    expect(b.run).not.toBe(a.run)
    const kinds = written().map((e) => e.kind)
    expect(kinds.filter((k) => k === 'run.started').length).toBe(3)
    expect(kinds.filter((k) => k === 'run.ended').length).toBe(2)
  })

  it('says how a turn ended when it was cancelled or failed', () => {
    beginChatRun('t2')
    nextChatInvocation('t2')
    endChatRun('t2', 'cancelled')
    beginChatRun('t2')
    endChatRun('t2', 'error', 'upstream 500')
    const ends = written().filter((e) => e.kind === 'run.ended')
    expect(ends[0].payload).toMatchObject({ stoppedBy: 'cancelled', steps: 1 })
    expect(ends[1].payload).toMatchObject({ stoppedBy: 'error', detail: 'upstream 500' })
    // Two turns, two runs: an ended turn never lends its id to the next.
    expect(ends[0].run).not.toBe(ends[1].run)
  })

  it('records which payload a request sent, and remembers it for the turn', () => {
    const run = beginChatRun('snap', { model: 'm' })
    const invocation = nextChatInvocation('snap')
    recordChatDispatch('snap', {
      id: 'snap-1',
      hash: 'fnv1a64:abc',
      redactions: 2,
      invocation,
    })
    const dispatched = written().find((e) => e.payload?.phase === 'dispatched')
    expect(dispatched).toMatchObject({
      session: 'snap',
      run: run.run,
      invocation,
      kind: 'message.completed',
      payload: { snapshotId: 'snap-1', hash: 'fnv1a64:abc', redactions: 2 },
    })
    // And the turn knows which request it last sent, which is what a memory
    // use names.
    expect(chatSnapshotId('snap')).toBe('snap-1')
    // A second request of the same turn replaces it.
    const second = nextChatInvocation('snap')
    recordChatDispatch('snap', { id: 'snap-2', hash: 'h2', invocation: second })
    expect(chatSnapshotId('snap')).toBe('snap-2')
    // The turn is still one run.
    const runs = new Set(written().map((e) => e.run))
    expect(runs).toEqual(new Set([run.run]))
  })

  it('records no dispatch for a thread with no turn, and none without an id', () => {
    recordChatDispatch('nothing-running', { id: 'x', hash: 'h' })
    expect(recordEvents).not.toHaveBeenCalled()
    expect(chatSnapshotId('nothing-running')).toBeUndefined()
    beginChatRun('empty')
    recordChatDispatch('empty', { id: '', hash: 'h' })
    expect(written().some((e) => e.payload?.phase === 'dispatched')).toBe(false)
    expect(chatSnapshotId('empty')).toBeUndefined()
  })

  it('records nothing for a thread that has no turn running', () => {
    expect(nextChatInvocation('idle')).toBe('')
    recordChatUsage('idle', 'inv', { inputTokens: 1 })
    recordChatMessage('idle', 'inv', {})
    endChatRun('idle', 'done')
    expect(recordEvents).not.toHaveBeenCalled()
  })

  it('keeps two threads' + ' runs apart', () => {
    const a = beginChatRun('a')
    const b = beginChatRun('b')
    expect(a.run).not.toBe(b.run)
    const inA = nextChatInvocation('a')
    const inB = nextChatInvocation('b')
    expect(inA.startsWith(a.run)).toBe(true)
    expect(inB.startsWith(b.run)).toBe(true)
    endChatRun('a', 'done')
    expect(chatRunOf('b')?.run).toBe(b.run)
  })

  it('ignores a superseded request ending or marking a newer turn (#137)', () => {
    const stale = continueOrBeginChatRun('t', { model: 'm' }).run
    // Stop and resend: the newer request opens its own turn first.
    const fresh = continueOrBeginChatRun('t', { model: 'm' }).run
    expect(fresh).not.toBe(stale)
    nextChatInvocation('t')

    markChatAwaitingTools('t', true, stale)
    expect(chatAwaitsTools('t')).toBe(false)
    expect(chatAwaitsTools('t', stale)).toBe(false)
    endChatRun('t', 'error', undefined, stale)
    endChatRun('t', 'cancelled', undefined, stale)

    const open = chatRunOf('t')
    expect(open?.run).toBe(fresh)
    expect(open?.steps).toBe(1)
    expect(open?.awaitingTools).toBe(false)
    expect(written().filter((e) => e.kind === 'run.ended' && e.run === fresh)).toEqual([])

    endChatRun('t', 'done', undefined, fresh)
    expect(chatRunOf('t')).toBeUndefined()
  })
})
