import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import {
  MAX_EVENTS_PER_CONVERSATION,
  useFileActivity,
} from '../useFileActivity'
import {
  deriveFromSubagent,
  deriveFromTurns,
  type FileActivityEvent,
  type ToolRecord,
} from '@/lib/fileActivity'

const store = () => useFileActivity.getState()

const event = (id: string, over: Partial<FileActivityEvent> = {}): FileActivityEvent => ({
  id,
  path: 'src/a.ts',
  operation: 'read',
  seq: 0,
  at: 0,
  ok: true,
  origin: 'project',
  ...over,
})

beforeEach(() => useFileActivity.setState({ byConversation: {} }))

describe('recording activity', () => {
  it('keeps events per conversation', () => {
    store().record('a', [event('1')])
    store().record('b', [event('2', { path: 'other.ts' })])

    expect(store().eventsFor('a')).toHaveLength(1)
    expect(store().eventsFor('b')[0].path).toBe('other.ts')
  })

  it('never lets one conversation see another’s paths', () => {
    store().record('a', [event('1', { path: 'secret/a.ts' })])
    expect(store().eventsFor('b')).toEqual([])
    expect(store().eventsFor(null)).toEqual([])
  })

  it('does not record the same call twice', () => {
    store().record('a', [event('1')])
    store().record('a', [event('1')])
    expect(store().eventsFor('a')).toHaveLength(1)
  })

  it('ignores an empty batch rather than touching state', () => {
    store().record('a', [event('1')])
    const before = store().eventsFor('a')
    store().record('a', [])
    expect(store().eventsFor('a')).toBe(before)
  })

  it('trims the oldest once the list is long', () => {
    const many = Array.from({ length: MAX_EVENTS_PER_CONVERSATION + 5 }, (_, i) =>
      event(String(i), { seq: i })
    )
    store().record('a', many)
    const kept = store().eventsFor('a')
    expect(kept).toHaveLength(MAX_EVENTS_PER_CONVERSATION)
    expect(kept[0].id).toBe('5')
  })
})

describe('forgetting a conversation', () => {
  it('drops its paths so they do not outlive it', () => {
    store().record('a', [event('1')])
    store().forget('a')
    expect(store().eventsFor('a')).toEqual([])
  })

  it('leaves other conversations alone', () => {
    store().record('a', [event('1')])
    store().record('b', [event('2')])
    store().forget('a')
    expect(store().eventsFor('b')).toHaveLength(1)
  })
})

describe('what is persisted', () => {
  it('stores references, and survives a restart', () => {
    const options = useFileActivity.persist.getOptions()
    const partialize = options.partialize as (s: unknown) => Record<string, unknown>
    store().record('a', [event('1')])
    expect(Object.keys(partialize(store()))).toEqual(['byConversation'])
    expect(options.skipHydration).toBe(true)
  })

  it('keeps no file contents, only what points at them', () => {
    store().record('a', [event('1', { hasDiff: true })])
    const serialized = JSON.stringify(store().eventsFor('a'))
    expect(serialized).not.toMatch(/content|body|text/)
    expect(serialized).toMatch(/hasDiff/)
  })
})

/**
 * A run, recorded the way the route records one.
 *
 * `onStep` derives from that step's settled turns and records them as they
 * land; the commit at the end derives from the whole turn list again. These
 * helpers make exactly those two calls, so what is under test is the pipeline
 * the app runs, not a rehearsal of it.
 */
describe('a run recording its file work as it goes', () => {
  const SID = 'session-a'
  const projectOrigin = () => 'project' as const

  const tool = (over: Partial<ToolRecord> = {}): ToolRecord => ({
    callId: 'call-1',
    name: 'read',
    args: { path: 'src/a.ts' },
    status: 'done',
    ...over,
  })

  /** One `onStep` delivery. */
  const step = (turns: ToolRecord[], at = 1_000, sid = SID) =>
    store().record(sid, deriveFromTurns(turns, projectOrigin, at))

  /** The sweep the route runs when the turn commits. */
  const commit = (turns: ToolRecord[], at = 1_000, sid = SID) =>
    store().record(sid, deriveFromTurns(turns, projectOrigin, at))

  const rows = (sid = SID) => store().eventsFor(sid)
  const ids = (sid = SID) => rows(sid).map((e) => e.toolCallId)

  it('records each operation as it settles, not only at the end', () => {
    step([tool({ callId: 'c1' })])
    expect(rows()).toHaveLength(1)

    step([tool({ callId: 'c2', name: 'write', args: { path: 'src/b.ts' } })])
    expect(ids()).toEqual(['c1', 'c2'])
  })

  it('records nothing for a call still running, and never back-fills it', () => {
    step([tool({ callId: 'c1', status: 'running' })])
    expect(rows()).toHaveLength(0)

    // The run is cancelled here: the call never settles. Nothing may appear,
    // and certainly not as a success.
    expect(rows().some((e) => e.ok)).toBe(false)
  })

  it('keeps what settled before a cancellation and adds nothing after', () => {
    step([tool({ callId: 'c1' })])
    step([tool({ callId: 'c2', status: 'running', args: { path: 'src/b.ts' } })])

    expect(ids()).toEqual(['c1'])
    expect(rows()[0].ok).toBe(true)
  })

  it('records a failed operation as failed, never as a success', () => {
    step([tool({ callId: 'c1', isError: true })])

    expect(rows()).toHaveLength(1)
    expect(rows()[0].ok).toBe(false)
  })

  it('records a retry under its own call id, beside the attempt that failed', () => {
    step([tool({ callId: 'c1', isError: true })])
    step([tool({ callId: 'c2' })])

    expect(ids()).toEqual(['c1', 'c2'])
    expect(rows().map((e) => e.ok)).toEqual([false, true])
  })

  it('records one row when the same call is delivered twice', () => {
    step([tool({ callId: 'c1' })])
    step([tool({ callId: 'c1' })])

    expect(rows()).toHaveLength(1)
  })

  it('adds nothing when the commit re-derives calls already recorded', () => {
    step([tool({ callId: 'c1' })])
    step([tool({ callId: 'c2', args: { path: 'src/b.ts' } })])

    commit([tool({ callId: 'c1' }), tool({ callId: 'c2', args: { path: 'src/b.ts' } })])

    expect(rows()).toHaveLength(2)
    expect(ids()).toEqual(['c1', 'c2'])
  })

  it('records a subagent’s work alongside the main agent’s, attributed', () => {
    step([tool({ callId: 'c1' })])
    store().record(
      SID,
      deriveFromSubagent(
        'researcher',
        [tool({ callId: 'c2', args: { path: 'src/b.ts' } })],
        projectOrigin,
        2_000
      )
    )

    expect(rows().map((e) => e.agent)).toEqual([undefined, 'researcher'])
  })

  it('keeps every operation that touched one file', () => {
    step([tool({ callId: 'c1' })])
    step([tool({ callId: 'c2', name: 'write' })])

    expect(rows()).toHaveLength(2)
    expect(rows().every((e) => e.path === 'src/a.ts')).toBe(true)
    expect(rows().map((e) => e.operation)).toEqual(['read', 'write'])
  })

  it('orders steps that share a timestamp by the order they arrived', () => {
    // `onStep` stamps with the wall clock, so two steps in the same
    // millisecond carry the same base. Arrival order has to settle it.
    step([tool({ callId: 'c1' })], 1_000)
    step([tool({ callId: 'c2', args: { path: 'src/b.ts' } })], 1_000)
    step([tool({ callId: 'c3', args: { path: 'src/c.ts' } })], 1_000)

    expect(ids()).toEqual(['c1', 'c2', 'c3'])
  })

  it('records against the session that ran the work, not the one now open', () => {
    step([tool({ callId: 'c1' })], 1_000, 'session-a')
    // The user switches to another session while the run continues.
    step([tool({ callId: 'c2', args: { path: 'src/b.ts' } })], 1_000, 'session-b')

    expect(ids('session-a')).toEqual(['c1'])
    expect(ids('session-b')).toEqual(['c2'])
  })
})
