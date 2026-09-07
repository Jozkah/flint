import { describe, it, expect } from 'vitest'
import { assistantAnchorId, coworkTurnsToUIMessages } from '@/lib/coworkTurns'
import type { CoworkTurn } from '@/hooks/useCoworkSessions'

/* eslint-disable @typescript-eslint/no-explicit-any */
const partsOf = (messages: any[], index = 0) => messages[index]?.parts ?? []
const toolPart = (turns: CoworkTurn[]) =>
  partsOf(coworkTurnsToUIMessages(turns)).find((p: any) =>
    p.type?.startsWith('tool-')
  )

describe('coworkTurnsToUIMessages', () => {
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
