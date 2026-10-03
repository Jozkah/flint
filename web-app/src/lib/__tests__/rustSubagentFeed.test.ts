import { describe, it, expect, beforeEach } from 'vitest'
import { RustSubagentFeed, MAX_FEED_TEXT, MAX_FEED_TURNS } from '../rustSubagentFeed'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { backgroundTasksOf, emptyActivityState, taskIdFor } from '../coworkActivity'
import type { StreamEvent } from '@/hooks/useCoworkRun'

const ctx = { sessionId: 's1', runId: 'run-1', model: 'qwen3' }
const id = (runId: string) => taskIdFor('s1', 'run-1', runId)
const task = (runId: string) => useCoworkActivity.getState().tasks[id(runId)]

const wrapped = (run_id: string, event: StreamEvent): StreamEvent => ({
  type: 'subagent',
  run_id,
  name: 'explorer',
  event,
})

/** What `core::agent` emits for one child that reads a file and answers. */
const lifecycle = (run = 'sub-explorer-1'): StreamEvent[] => [
  { type: 'subagent_start', run_id: run, name: 'explorer', task: 'find the loader' },
  wrapped(run, { type: 'tool_call', id: 't1', name: 'read', args: { path: 'a.ts' } }),
  wrapped(run, { type: 'tool_result', id: 't1', content: 'file body', is_error: false }),
  wrapped(run, { type: 'token', text: 'It is in a.ts.' }),
  {
    type: 'subagent_finished',
    run_id: run,
    name: 'explorer',
    status: 'done',
    usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 },
  },
  { type: 'subagent_end', run_id: run, name: 'explorer' },
]

beforeEach(() => {
  useCoworkActivity.setState({ ...emptyActivityState() })
})

describe('RustSubagentFeed', () => {
  it('records a dispatched child as a background task with its brief and model', () => {
    const feed = new RustSubagentFeed(ctx)
    feed.apply({ type: 'subagent_start', run_id: 'r', name: 'explorer', task: 'find the loader' })
    const t = task('r')
    expect(t).toMatchObject({
      kind: 'agent',
      status: 'running',
      agentName: 'explorer',
      description: 'find the loader',
      model: 'qwen3',
      background: true,
    })
    expect(backgroundTasksOf(useCoworkActivity.getState(), 's1').running).toHaveLength(1)
  })

  it('shows a queued child with its position, then running once it starts', () => {
    const feed = new RustSubagentFeed(ctx)
    feed.apply({ type: 'subagent_queued', run_id: 'r', name: 'explorer', waiting: 2 })
    expect(task('r')).toMatchObject({ status: 'queued', waiting: 2 })
    feed.apply({ type: 'subagent_start', run_id: 'r', name: 'explorer' })
    expect(task('r').status).toBe('running')
    expect(task('r').waiting).toBeUndefined()
  })

  it('builds the transcript and tool count from the child’s wrapped events, live', () => {
    const feed = new RustSubagentFeed(ctx)
    const events = lifecycle()
    for (const ev of events.slice(0, 3)) feed.apply(ev)
    expect(task('sub-explorer-1').toolCount).toBe(1)
    expect(task('sub-explorer-1').transcript?.[0]).toMatchObject({ role: 'tool', name: 'read', result: 'file body' })
    for (const ev of events.slice(3, 4)) feed.apply(ev)
    expect(task('sub-explorer-1').transcript?.at(-1)).toMatchObject({ role: 'assistant', content: 'It is in a.ts.' })
  })

  it('records how it ended, its own usage and the end of the bracket', () => {
    const feed = new RustSubagentFeed(ctx)
    feed.replay(lifecycle())
    expect(task('sub-explorer-1')).toMatchObject({
      status: 'done',
      usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 },
    })
    expect(task('sub-explorer-1').endedAt).toBeGreaterThan(0)
  })

  it('marks a child that ran out of turns, distinct from a plain failure', () => {
    const feed = new RustSubagentFeed(ctx)
    feed.apply({ type: 'subagent_start', run_id: 'a', name: 'x' })
    feed.apply({ type: 'subagent_finished', run_id: 'a', name: 'x', status: 'turn_limit', detail: 'used all 60' })
    expect(task('a')).toMatchObject({ status: 'error', stoppedAtLimit: true, detail: 'used all 60' })
    feed.apply({ type: 'subagent_start', run_id: 'b', name: 'x' })
    feed.apply({ type: 'subagent_finished', run_id: 'b', name: 'x', status: 'error', detail: 'boom' })
    expect(task('b').status).toBe('error')
    expect(task('b').stoppedAtLimit).toBeUndefined()
  })

  it('settles a child whose emitter sent only subagent_end, and keeps a finished status', () => {
    const feed = new RustSubagentFeed(ctx)
    feed.apply({ type: 'subagent_start', run_id: 'old', name: 'x' })
    feed.apply({ type: 'subagent_end', run_id: 'old', name: 'x', usage: { total_tokens: 7 } })
    expect(task('old')).toMatchObject({ status: 'done', usage: { total_tokens: 7 } })
    feed.apply({ type: 'subagent_start', run_id: 'e', name: 'x' })
    feed.apply({ type: 'subagent_finished', run_id: 'e', name: 'x', status: 'error' })
    feed.apply({ type: 'subagent_end', run_id: 'e', name: 'x' })
    expect(task('e').status).toBe('error')
  })

  it('catches up a feed attached after the child started, and replays idempotently', () => {
    const early = new RustSubagentFeed(ctx)
    const events = lifecycle()
    for (const ev of events.slice(0, 3)) early.apply(ev)

    // A panel opened now: a new feed gets what the host kept, then live events.
    useCoworkActivity.setState({ ...emptyActivityState() })
    const late = new RustSubagentFeed(ctx)
    late.replay(early.events())
    expect(task('sub-explorer-1')).toMatchObject({ status: 'running', toolCount: 1 })
    for (const ev of events.slice(3)) late.apply(ev)
    expect(task('sub-explorer-1').status).toBe('done')

    const snapshot = JSON.stringify(task('sub-explorer-1').transcript)
    const again = new RustSubagentFeed(ctx)
    again.replay(events)
    expect(JSON.stringify(task('sub-explorer-1').transcript)).toBe(snapshot)
    expect(Object.keys(useCoworkActivity.getState().tasks)).toHaveLength(1)
  })

  it('runs several children side by side as separate rows', () => {
    const feed = new RustSubagentFeed(ctx)
    for (const run of ['a', 'b', 'c']) {
      feed.apply({ type: 'subagent_start', run_id: run, name: 'explorer' })
    }
    feed.apply(wrapped('b', { type: 'token', text: 'only b' }))
    expect(Object.keys(useCoworkActivity.getState().tasks)).toHaveLength(3)
    expect(task('a').transcript).toBeUndefined()
    expect(task('b').transcript?.[0].content).toBe('only b')
    expect(backgroundTasksOf(useCoworkActivity.getState(), 's1').running).toHaveLength(3)
  })

  it('bounds what it keeps: turns, text, and secrets', () => {
    const feed = new RustSubagentFeed(ctx)
    feed.apply({ type: 'subagent_start', run_id: 'big', name: 'x', task: 'use sk-abcdefghijklmnopqrstuvwxyz123456' })
    for (let i = 0; i < MAX_FEED_TURNS + 50; i += 1) {
      feed.apply(wrapped('big', { type: 'tool_call', id: `t${i}`, name: 'read', args: { path: `f${i}` } }))
      feed.apply(wrapped('big', { type: 'tool_result', id: `t${i}`, content: 'y'.repeat(MAX_FEED_TEXT * 2), is_error: false }))
    }
    const t = task('big')
    expect(t.transcript!.length).toBeLessThanOrEqual(MAX_FEED_TURNS)
    expect(t.transcript!.at(-1)!.result!.length).toBeLessThan(MAX_FEED_TEXT + 100)
    expect(t.transcript!.at(-1)!.result).toContain('more characters not kept')
    expect(t.description).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
  })

  it('ignores events that are not about a subagent', () => {
    const feed = new RustSubagentFeed(ctx)
    feed.apply({ type: 'token', text: 'hi' })
    expect(Object.keys(useCoworkActivity.getState().tasks)).toHaveLength(0)
  })
})
