import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { UIMessage } from 'ai'
import { chatLiveReply, coworkLiveReply, diffLiveReply, type LiveReply } from '../live'
import { reportLiveReply, resetStreams, setStreamSink, streamSnapshot } from '../streams'
import { createIdempotencyCache } from '../idempotency'
import { registerComposer, resetComposers, waitForComposer } from '../composer'
import type { CoworkTurn } from '@/types/coworkSession'

vi.mock('@/hooks/useAppState', () => ({ useAppState: {} }))

const reply = (over: Partial<LiveReply> = {}): LiveReply => ({
  messageId: 'm1',
  text: '',
  reasoning: '',
  tools: [],
  ...over,
})

describe('chatLiveReply', () => {
  const msgs = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'Think' },
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'there' },
        { type: 'tool-read', toolCallId: 't1', state: 'input-available', input: { path: 'a.go' } },
      ],
    },
  ] as unknown as UIMessage[]

  it('is the last assistant message while streaming', () => {
    const r = chatLiveReply(msgs, 'streaming')!
    expect(r).toMatchObject({ messageId: 'a1', text: 'Hello there', reasoning: 'Think' })
    expect(r.tools).toEqual([expect.objectContaining({ id: 't1', name: 'read', status: 'running', arg: 'a.go' })])
  })

  it('is nothing once ready', () => {
    expect(chatLiveReply(msgs, 'ready')).toBeNull()
    expect(chatLiveReply(msgs.slice(0, 1), 'submitted')).toBeNull()
  })
})

describe('coworkLiveReply', () => {
  it('joins the text and maps tool turns to steps', () => {
    const turns = [
      { role: 'assistant', content: 'Reading.' },
      { role: 'tool', content: '', callId: 'c1', name: 'read', args: { path: 'x.go' }, status: 'done', toolState: 'succeeded' },
      { role: 'tool', content: '', callId: 'c2', name: 'bash', args: { command: 'go test' }, status: 'running', toolState: 'running' },
      { role: 'tool', content: '', callId: 'c3', name: 'bash', args: { command: 'git push' }, status: 'running' },
      { role: 'assistant', content: 'Now testing.' },
    ] as CoworkTurn[]
    const r = coworkLiveReply('run1', turns, new Set(['c3']))
    expect(r.messageId).toBe('run1')
    expect(r.text).toBe('Reading.\n\nNow testing.')
    expect(r.tools.map((t) => [t.id, t.status, t.kind])).toEqual([
      ['c1', 'done', 'read'],
      ['c2', 'running', 'bash'],
      ['c3', 'awaiting', 'appr'],
    ])
  })
})

describe('diffLiveReply', () => {
  it('sends what was appended, and whole text when it was rewritten', () => {
    expect(diffLiveReply('chat', 't', null, reply({ text: 'Hel' }))).toEqual([
      { type: 'stream.delta', kind: 'chat', id: 't', messageId: 'm1', offset: 0, text: 'Hel' },
    ])
    expect(diffLiveReply('chat', 't', reply({ text: 'Hel' }), reply({ text: 'Hello' }))).toEqual([
      { type: 'stream.delta', kind: 'chat', id: 't', messageId: 'm1', offset: 3, text: 'lo' },
    ])
    expect(diffLiveReply('chat', 't', reply({ text: 'Hello' }), reply({ text: 'Bye' }))[0]).toMatchObject({
      offset: 0,
      text: 'Bye',
    })
  })

  it('sends reasoning with its own offset', () => {
    expect(diffLiveReply('chat', 't', reply({ reasoning: 'a' }), reply({ reasoning: 'ab' }))[0]).toMatchObject({
      offset: 0,
      text: '',
      reasoningOffset: 1,
      reasoning: 'b',
    })
  })

  it('sends new and changed tool steps, and done when the reply ends', () => {
    const step = { id: 's1', name: 'bash', kind: 'bash' as const, status: 'running' as const }
    const events = diffLiveReply('cowork', 'w', reply({ tools: [step] }), reply({ tools: [{ ...step, status: 'done' }] }))
    expect(events).toEqual([{ type: 'stream.tool', kind: 'cowork', id: 'w', messageId: 'm1', step: { ...step, status: 'done' } }])
    expect(diffLiveReply('cowork', 'w', reply(), null)).toEqual([{ type: 'stream.done', kind: 'cowork', id: 'w', messageId: 'm1' }])
    // A new message ends the old one first.
    expect(diffLiveReply('chat', 't', reply(), reply({ messageId: 'm2', text: 'x' })).map((e) => e.type)).toEqual([
      'stream.done',
      'stream.delta',
    ])
  })
})

describe('reportLiveReply', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetStreams()
  })
  afterEach(() => {
    resetStreams()
    vi.useRealTimers()
  })

  it('coalesces text, sends endings at once, and keeps the snapshot', () => {
    const sink = vi.fn()
    setStreamSink(sink)
    reportLiveReply('chat', 't1', reply({ text: 'H' }))
    reportLiveReply('chat', 't1', reply({ text: 'He' }))
    reportLiveReply('chat', 't1', reply({ text: 'Hel' }))
    expect(sink).not.toHaveBeenCalled()
    expect(streamSnapshot('chat', 't1')).toMatchObject({ messageId: 'm1', text: 'Hel' })
    vi.advanceTimersByTime(200)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ type: 'stream.delta', offset: 0, text: 'Hel' }), 'thread:t1')
    reportLiveReply('chat', 't1', reply({ text: 'Hello' }))
    reportLiveReply('chat', 't1', null)
    expect(sink.mock.calls.map((c) => c[0].type)).toEqual(['stream.delta', 'stream.delta', 'stream.done'])
    expect(sink.mock.calls[1][0]).toMatchObject({ offset: 3, text: 'lo' })
    expect(streamSnapshot('chat', 't1')).toBeNull()
  })

  it('without a sink keeps snapshots and sends nothing', () => {
    reportLiveReply('cowork', 'w1', reply({ text: 'x' }))
    expect(streamSnapshot('cowork', 'w1')).toMatchObject({ text: 'x' })
  })
})

describe('createIdempotencyCache', () => {
  it('runs once per key and forgets after the TTL or on failure', async () => {
    let t = 0
    const cache = createIdempotencyCache({ ttlMs: 1000, max: 2, now: () => t })
    const fn = vi.fn(async () => ({ v: 1 }))
    expect(await cache.once('a', fn)).toEqual({ v: 1 })
    expect(await cache.once('a', fn)).toEqual({ v: 1, duplicate: true })
    expect(fn).toHaveBeenCalledTimes(1)
    t = 5000
    await cache.once('a', fn)
    expect(fn).toHaveBeenCalledTimes(2)
    await expect(cache.once('b', async () => Promise.reject(new Error('no')))).rejects.toThrow('no')
    expect(await cache.once('b', fn)).toEqual({ v: 1 })
    await cache.once('c', fn)
    await cache.once('d', fn)
    expect(cache.size()).toBeLessThanOrEqual(2)
  })
})

describe('composer registry', () => {
  beforeEach(() => resetComposers())

  it('waits for a conversation to mount, and times out', async () => {
    vi.useFakeTimers()
    const waiting = waitForComposer('chat', 'c1', 1000)
    const send = vi.fn()
    const off = registerComposer('chat', 'c1', { send })
    expect(await waiting).toMatchObject({ send })
    off()
    const late = waitForComposer('chat', 'c1', 1000)
    vi.advanceTimersByTime(1500)
    expect(await late).toBeNull()
    vi.useRealTimers()
  })
})
