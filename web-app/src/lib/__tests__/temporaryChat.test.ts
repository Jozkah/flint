import { describe, it, expect } from 'vitest'
import {
  isEmptyTemporaryChat,
  shouldConfirmLeaving,
  readdressMessage,
  readdressMessages,
  titleForKeptChat,
  persistedEverything,
  persistedThread,
  overridesToCarry,
  TEMPORARY_STATE_OWNERS,
} from '@/lib/temporaryChat'

// The pure decision layer under the temporary-chat lifecycle. No React, no
// stores: every rule that keeps a discard exhaustive and a keep honest is
// testable in isolation here.

describe('isEmptyTemporaryChat', () => {
  it('treats undefined and empty as empty', () => {
    expect(isEmptyTemporaryChat(undefined)).toBe(true)
    expect(isEmptyTemporaryChat([])).toBe(true)
  })
  it('is not empty once there is a message', () => {
    expect(isEmptyTemporaryChat([{ id: 'a' }])).toBe(false)
  })
})

describe('shouldConfirmLeaving', () => {
  it('asks only for a non-empty temporary chat', () => {
    expect(
      shouldConfirmLeaving({ threadId: 'temporary-chat', messages: [{ id: 'a' }] })
    ).toBe(true)
  })
  it('never asks for a real thread', () => {
    expect(
      shouldConfirmLeaving({ threadId: 'real-thread', messages: [{ id: 'a' }] })
    ).toBe(false)
  })
  it('never asks for an empty temporary chat', () => {
    expect(
      shouldConfirmLeaving({ threadId: 'temporary-chat', messages: [] })
    ).toBe(false)
    expect(
      shouldConfirmLeaving({ threadId: 'temporary-chat', messages: undefined })
    ).toBe(false)
  })
  it('never asks with no thread at all', () => {
    expect(shouldConfirmLeaving({ threadId: null, messages: [{ id: 'a' }] })).toBe(
      false
    )
  })
})

describe('readdressMessage', () => {
  it('changes only the thread id, carrying everything else verbatim', () => {
    const message = {
      id: 'm1',
      thread_id: 'temporary-chat',
      role: 'user',
      content: [{ type: 'text', text: { value: 'hi' } }],
      metadata: { tokens: 3, attachments: ['a.png'] },
    }
    const moved = readdressMessage(message, 'kept-1')
    expect(moved.thread_id).toBe('kept-1')
    expect(moved.id).toBe('m1')
    expect(moved.metadata).toEqual(message.metadata)
    expect(moved.content).toBe(message.content)
    // Original is not mutated.
    expect(message.thread_id).toBe('temporary-chat')
  })

  it('re-addresses a whole conversation', () => {
    const moved = readdressMessages(
      [
        { id: 'a', thread_id: 'temporary-chat' },
        { id: 'b', thread_id: 'temporary-chat' },
      ],
      'kept-1'
    )
    expect(moved.map((m) => m.thread_id)).toEqual(['kept-1', 'kept-1'])
    expect(moved.map((m) => m.id)).toEqual(['a', 'b'])
  })
})

describe('titleForKeptChat', () => {
  it('uses the first thing the user said', () => {
    expect(titleForKeptChat('What is a monad?', 'Kept chat')).toBe(
      'What is a monad?'
    )
  })
  it('collapses whitespace', () => {
    expect(titleForKeptChat('  hello   there\n', 'Kept chat')).toBe('hello there')
  })
  it('falls back when there is no text (e.g. an image-only message)', () => {
    expect(titleForKeptChat(undefined, 'Kept chat')).toBe('Kept chat')
    expect(titleForKeptChat('   ', 'Kept chat')).toBe('Kept chat')
  })
  it('truncates long titles with an ellipsis', () => {
    const long = 'x'.repeat(100)
    const title = titleForKeptChat(long, 'Kept chat')
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(61)
  })
})

describe('persistedEverything', () => {
  it('is false when the read-back returned nothing', () => {
    expect(persistedEverything([{ id: 'a' }], undefined)).toBe(false)
  })
  it('is true only when every expected message is present', () => {
    expect(persistedEverything([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }])).toBe(
      false
    )
    expect(
      persistedEverything([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'b' }])
    ).toBe(true)
  })
  it('tolerates extra messages already on the thread', () => {
    expect(
      persistedEverything([{ id: 'a' }], [{ id: 'a' }, { id: 'z' }])
    ).toBe(true)
  })
  it('an empty conversation is trivially persisted', () => {
    expect(persistedEverything([], [])).toBe(true)
  })
})

describe('persistedThread', () => {
  it('is false when the read-back returned nothing', () => {
    expect(persistedThread('kept-1', undefined)).toBe(false)
  })
  it('is false when the thread is absent from the durable list', () => {
    expect(persistedThread('kept-1', [{ id: 'other' }])).toBe(false)
  })
  it('is true when the thread is present', () => {
    expect(persistedThread('kept-1', [{ id: 'other' }, { id: 'kept-1' }])).toBe(
      true
    )
  })
})

describe('overridesToCarry', () => {
  it('carries nothing for an empty or missing override set', () => {
    expect(overridesToCarry(undefined)).toBeUndefined()
    expect(overridesToCarry({})).toBeUndefined()
  })
  it('copies a sparse override set (a new object, not the original)', () => {
    const overrides = { temperature: 0.2 }
    const carried = overridesToCarry(overrides)
    expect(carried).toEqual({ temperature: 0.2 })
    expect(carried).not.toBe(overrides)
  })
})

describe('TEMPORARY_STATE_OWNERS', () => {
  it('names every store a discard must sweep', () => {
    // A store forgotten here is one the next temporary chat silently inherits.
    expect(TEMPORARY_STATE_OWNERS).toEqual([
      'thread',
      'messages',
      'appState',
      'modelOverrides',
    ])
  })
})
