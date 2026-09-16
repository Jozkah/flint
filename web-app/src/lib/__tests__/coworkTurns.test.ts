import { describe, it, expect } from 'vitest'
import {
  appendLiveMessages,
  assistantAnchorId,
  coworkTurnsToUIMessages,
} from '@/lib/coworkTurns'
import type { CoworkTurn } from '@/hooks/useCoworkSessions'

/* eslint-disable @typescript-eslint/no-explicit-any */
const partsOf = (messages: any[], index = 0) => messages[index]?.parts ?? []
const toolPart = (turns: CoworkTurn[]) =>
  partsOf(coworkTurnsToUIMessages(turns)).find((p: any) =>
    p.type?.startsWith('tool-')
  )

describe('coworkTurnsToUIMessages', () => {
  it('forwards assistant token speed metadata for the shared indicator', () => {
    const messages = coworkTurnsToUIMessages([
      { role: 'assistant', content: 'answer', tokenSpeed: { tokenSpeed: 42, promptSpeed: 120 } },
    ]) as any[]
    expect(messages[0].metadata.tokenSpeed).toEqual({
      tokenSpeed: 42,
      promptSpeed: 120,
    })
  })

  it('starts a new user message and flushes the assistant before it', () => {
    const messages = coworkTurnsToUIMessages([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ])
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
  })

  /// janhq/jan#8864. A message handed to a run mid-way is marked, so the
  /// transcript can say it steered that run rather than started one.
  it('marks a steered user turn, and only that one', () => {
    const messages = coworkTurnsToUIMessages([
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: 'use pnpm', steered: true },
    ]) as any[]
    expect(messages[0].metadata).toBeUndefined()
    expect(messages[2].metadata).toEqual({ steered: true })
  })

  it('maps a tool turn onto a tool-<name> part carrying its input', () => {
    const part = toolPart([
      {
        role: 'tool',
        content: '',
        callId: 'call-1',
        name: 'edit',
        args: { path: 'a.ts' },
        result: 'ok',
        status: 'done',
      },
    ])
    expect(part.type).toBe('tool-edit')
    expect(part.toolCallId).toBe('call-1')
    expect(part.input).toEqual({ path: 'a.ts' })
    expect(part.state).toBe('output-available')
    expect(part.output).toBe('ok')
  })

  it('leaves a running tool call awaiting output', () => {
    const part = toolPart([
      { role: 'tool', content: '', callId: 'c', name: 'bash', status: 'running' },
    ])
    expect(part.state).toBe('input-available')
    expect(part.output).toBeUndefined()
    expect(part.errorText).toBeUndefined()
  })

  it('routes a failed tool call to errorText, not output', () => {
    const part = toolPart([
      {
        role: 'tool',
        content: '',
        callId: 'c',
        name: 'bash',
        result: 'boom',
        isError: true,
        status: 'done',
      },
    ])
    expect(part.state).toBe('output-error')
    expect(part.errorText).toBe('boom')
    expect(part.output).toBeUndefined()
  })

  // The diff used to be prepended to the output text, which both showed the
  // model a diff it authored and corrupted the output AgentToolWidget parses.
  // It now travels via useToolCallRuntime.diffs instead.
  it('keeps the diff out of the tool output entirely', () => {
    const diff = '@@ edit 1/1 @@\n-old\n+new'
    const part = toolPart([
      {
        role: 'tool',
        content: '',
        callId: 'c',
        name: 'edit',
        result: 'wrote a.ts',
        diff,
        status: 'done',
      },
    ])
    expect(part.output).toBe('wrote a.ts')
    expect(JSON.stringify(part)).not.toContain('+new')
  })

  it('falls back to legacy content when a turn has no result', () => {
    const part = toolPart([
      { role: 'tool', content: 'legacy body', callId: 'c', name: 'read' },
    ])
    expect(part.output).toBe('legacy body')
  })

  it('keeps ids unique across prefixes so committed and live turns can merge', () => {
    const turns: CoworkTurn[] = [{ role: 'user', content: 'hi' }]
    const committed = coworkTurnsToUIMessages(turns, 'c')
    const live = coworkTurnsToUIMessages(turns, 'l')
    expect(committed[0].id).not.toBe(live[0].id)
  })
})

describe('assistantAnchorId', () => {
  const user = (content: string): CoworkTurn => ({ role: 'user', content })
  const assistant = (content: string): CoworkTurn => ({
    role: 'assistant',
    content,
  })
  const tool = (callId: string): CoworkTurn => ({
    role: 'tool',
    content: '',
    name: 'bash',
    callId,
    status: 'running',
  })

  /** The id must name a message the conversion actually produces. */
  const messageIds = (turns: CoworkTurn[]) =>
    coworkTurnsToUIMessages(turns, 's').map((m) => m.id)

  it('names the message the current block is building', () => {
    const turns = [user('go'), assistant('thinking'), tool('c1')]
    const id = assistantAnchorId(turns, 's')
    expect(id).toBe('s-asst-1')
    expect(messageIds(turns)).toContain(id)
  })

  it('starts a new block after each user turn', () => {
    const turns = [
      user('first'),
      assistant('a'),
      user('second'),
      assistant('b'),
      tool('c1'),
    ]
    const id = assistantAnchorId(turns, 's')
    expect(id).toBe('s-asst-3')
    expect(messageIds(turns)).toContain(id)
  })

  it('skips an assistant turn that produced nothing', () => {
    // An empty assistant turn adds no parts, so it does not open the message.
    const turns = [user('go'), assistant(''), tool('c1')]
    const id = assistantAnchorId(turns, 's')
    expect(id).toBe('s-asst-2')
    expect(messageIds(turns)).toContain(id)
  })

  it('names a block that opened with a tool call', () => {
    const turns = [user('go'), tool('c1')]
    expect(assistantAnchorId(turns, 's')).toBe('s-asst-1')
    expect(messageIds(turns)).toContain('s-asst-1')
  })

  it('names nothing while the block has produced nothing', () => {
    expect(assistantAnchorId([], 's')).toBeUndefined()
    expect(assistantAnchorId([user('go')], 's')).toBeUndefined()
    expect(assistantAnchorId([user('go'), assistant('')], 's')).toBeUndefined()
  })

  it('handles a transcript that never had a user turn', () => {
    const turns = [assistant('resumed')]
    expect(assistantAnchorId(turns, 's')).toBe('s-asst-0')
    expect(messageIds(turns)).toContain('s-asst-0')
  })
})

describe('prompt snapshots ride the assistant message they produced', () => {
  const partsOfTurns = (turns: CoworkTurn[]) =>
    coworkTurnsToUIMessages(turns).flatMap((m: any) => m.parts)

  it('emits a snapshot part on the assistant message', () => {
    // AH-078: the viewer must sit with the invocation it belongs to.
    const parts = partsOfTurns([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'hello',
        promptSnapshot: { id: 'snap-7', hash: 'fnv1a64:abc', redactions: 1 },
      },
    ])
    const snap: any = parts.find((p: any) => p.type === 'data-prompt-snapshot')
    expect(snap).toBeTruthy()
    expect(snap.data.id).toBe('snap-7')
    expect(snap.data.hash).toBe('fnv1a64:abc')
    expect(snap.data.redactions).toBe(1)
  })

  it('keeps each snapshot with its own turn rather than a shared latest', () => {
    const messages = coworkTurnsToUIMessages([
      { role: 'user', content: 'one' },
      {
        role: 'assistant',
        content: 'first',
        promptSnapshot: { id: 'snap-1', hash: 'h1', redactions: 0 },
      },
      { role: 'user', content: 'two' },
      {
        role: 'assistant',
        content: 'second',
        promptSnapshot: { id: 'snap-2', hash: 'h2', redactions: 0 },
      },
    ])
    const ids = messages
      .flatMap((m: any) => m.parts)
      .filter((p: any) => p.type === 'data-prompt-snapshot')
      .map((p: any) => p.data.id)
    expect(ids).toEqual(['snap-1', 'snap-2'])
  })

  it('emits nothing when a turn has no snapshot', () => {
    const parts = partsOfTurns([{ role: 'assistant', content: 'plain' }])
    expect(parts.find((p: any) => p.type === 'data-prompt-snapshot')).toBeUndefined()
  })
})

describe('per-turn usage on the transcript', () => {
  it('carries a turn’s usage and memory ids as a display-only part', () => {
    const messages = coworkTurnsToUIMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'done',
        usage: { prompt_tokens: 900, completion_tokens: 4, total_tokens: 904, cached_prompt_tokens: 850 },
        memory: { injectedIds: ['mem-1'], conflictIds: [] },
      } as CoworkTurn,
    ])
    const part = partsOf(messages, 1).find((p: any) => p.type === 'data-turn-usage')
    expect(part?.data.usage.cached_prompt_tokens).toBe(850)
    expect(part?.data.memory.injectedIds).toEqual(['mem-1'])
  })

  it('adds nothing for a turn saved before per-turn usage existed', () => {
    const messages = coworkTurnsToUIMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'done' },
    ])
    expect(partsOf(messages, 1).some((p: any) => p.type === 'data-turn-usage')).toBe(false)
  })
})

describe('appendLiveMessages', () => {
  const committed: CoworkTurn[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'first' },
  ]

  it('an offset slice mints the ids the whole transcript would', () => {
    const live: CoworkTurn[] = [
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'second' },
    ]
    const whole = coworkTurnsToUIMessages([...committed, ...live], 's')
    const split = appendLiveMessages(
      coworkTurnsToUIMessages(committed, 's'),
      coworkTurnsToUIMessages(live, 's', {}, committed.length)
    )
    expect(split).toEqual(whole)
    expect(split.map((m) => m.id)).toEqual([
      's-user-0',
      's-asst-1',
      's-user-2',
      's-asst-3',
    ])
  })

  it('keeps every committed message identical across a live update', () => {
    const base = coworkTurnsToUIMessages(committed, 's')
    const live: CoworkTurn[] = [
      { role: 'user', content: 'again' },
      {
        role: 'tool',
        content: '',
        callId: 'c1',
        name: 'write',
        status: 'running',
        argsLive: '{"path":"a.html","content":"<h1>',
      },
    ]
    const out = appendLiveMessages(
      base,
      coworkTurnsToUIMessages(live, 's', {}, committed.length)
    )
    expect(out[0]).toBe(base[0])
    expect(out[1]).toBe(base[1])
    expect(out).toHaveLength(4)
  })

  it('joins a resumed run onto the committed assistant message', () => {
    const live: CoworkTurn[] = [{ role: 'assistant', content: 'continued' }]
    const whole = coworkTurnsToUIMessages([...committed, ...live], 's')
    const split = appendLiveMessages(
      coworkTurnsToUIMessages(committed, 's'),
      coworkTurnsToUIMessages(live, 's', {}, committed.length)
    )
    expect(split).toEqual(whole)
    expect(split).toHaveLength(2)
    expect(partsOf(split, 1).map((p: any) => p.text)).toEqual([
      'first',
      'continued',
    ])
  })

  it('returns the committed list itself when nothing is live', () => {
    const base = coworkTurnsToUIMessages(committed, 's')
    expect(appendLiveMessages(base, [])).toBe(base)
  })
})

describe('streamed tool arguments stay out of the rendered message', () => {
  // A `write` streams its body into `argsLive` (raw JSON) on the run store.
  // The transcript conversion renders `turn.args` (the parsed object, set only
  // once the call lands) as the tool part's `input`; `argsLive` is never a
  // message prop. So a multi-megabyte streamed argument cannot enter the
  // rendered props or the accessible DOM while it is arriving — only the live
  // tail re-renders, and it renders nothing of the body until it is parsed.
  it('does not leak a huge live argument buffer into the tool part', () => {
    const huge = 'X'.repeat(4 * 1024 * 1024) // 4 MB, mid-stream
    const messages = coworkTurnsToUIMessages([
      {
        role: 'tool',
        content: '',
        callId: 'c1',
        name: 'write',
        args: null,
        argsLive: `{"path":"big.txt","content":"${huge}`,
        status: 'running',
      },
    ]) as any[]
    const part = messages
      .flatMap((m) => m.parts)
      .find((p: any) => p.type === 'tool-write')
    expect(part).toBeTruthy()
    // The parsed args are absent while streaming, so the input is empty.
    expect(part.input).toBeNull()
    // The huge buffer is nowhere in what the renderer receives.
    expect(JSON.stringify(messages)).not.toContain('XXXX')
  })

  it('renders the full parsed arguments once the call has landed', () => {
    const messages = coworkTurnsToUIMessages([
      {
        role: 'tool',
        content: '',
        callId: 'c1',
        name: 'write',
        args: { path: 'big.txt', content: 'the whole body' },
        result: 'wrote big.txt',
        status: 'done',
      },
    ]) as any[]
    const part = messages
      .flatMap((m) => m.parts)
      .find((p: any) => p.type === 'tool-write')
    // Full arguments are available for dispatch/persistence and for the card.
    expect(part.input).toEqual({ path: 'big.txt', content: 'the whole body' })
  })
})
