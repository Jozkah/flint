import { describe, it, expect } from 'vitest'
import { summarizeChatContext, type ChatContextInput } from '../contextSummary'

const base = (overrides: Partial<ChatContextInput> = {}): ChatContextInput => ({
  model: { id: 'qwen3-8b', provider: 'llamacpp', location: 'local' },
  assistant: { name: 'Jan', hasInstructions: true },
  sentFiles: [],
  pendingFiles: [],
  indexedFiles: [],
  temporary: false,
  memory: null,
  memoryViews: [],
  tools: { modelSupportsTools: true, known: [], disabled: [] },
  ...overrides,
})

const section = (input: ChatContextInput, id: string) =>
  summarizeChatContext(input).find((s) => s.id === id)!

describe('summarizeChatContext', () => {
  it('states where the model runs, distinguishing local from remote', () => {
    expect(section(base(), 'model').items[0].reason).toBe('location.local')
    expect(
      section(base({ model: { id: 'gpt', provider: 'openai', location: 'remote' } }), 'model')
        .items[0].reason
    ).toBe('location.remote')
  })

  it('distinguishes inline, indexed and pending attachments', () => {
    const items = section(
      base({
        sentFiles: [
          { id: 'a', name: 'notes.txt', injectionMode: 'inline' },
          { id: 'b', name: 'book.pdf', injectionMode: 'embeddings' },
        ],
        indexedFiles: [{ id: 'b', name: 'book.pdf' }, { id: 'c', name: 'old.pdf' }],
        pendingFiles: [{ name: 'next.md', type: 'document', parseMode: 'inline' }],
      }),
      'attachments'
    ).items
    expect(items.map((i) => [i.label, i.state])).toEqual([
      ['next.md', 'pending-next-message'],
      ['notes.txt', 'included-with-message'],
      ['book.pdf', 'available-on-search'],
      ['old.pdf', 'available-on-search'],
    ])
    expect(items[0].action).toBe('remove-pending-attachment')
    // Retrieval is never claimed as inclusion.
    expect(items[2].reason).toBe('retrievalNotRecorded')
  })

  it('does not imply every saved memory was sent', () => {
    expect(section(base(), 'memory').items[0].state).toBe('not-recorded')

    const sent = section(
      base({
        memory: {
          block: '...',
          injectedIds: ['m1'],
          injectedHashes: ['h'],
          conflictIds: ['m2', 'm3'],
          droppedIds: ['m4'],
          charsUsed: 40,
        },
        memoryViews: [{ id: 'm1', scope: 'user', preview: 'Prefers metric units' } as never],
      }),
      'memory'
    ).items
    expect(sent[0]).toMatchObject({
      label: 'Prefers metric units',
      state: 'included-last-request',
      scope: 'across-chats',
    })
    expect(sent.find((i) => i.key === 'memory:conflicts')?.state).toBe('not-offered')
    expect(sent.find((i) => i.key === 'memory:dropped')?.detail).toBe('1')
  })

  it('says memory is off in a temporary chat', () => {
    expect(section(base({ temporary: true }), 'memory').items[0].reason).toBe('temporaryChat')
  })

  it('offers no tools to a model without tool support, and says why', () => {
    const items = section(
      base({ tools: { modelSupportsTools: false, known: ['fs::read'], disabled: [] } }),
      'tools'
    ).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ state: 'not-offered', reason: 'modelWithoutTools' })
  })

  it('lists enabled tools as available, not as used, and counts turned-off ones', () => {
    const items = section(
      base({
        tools: { modelSupportsTools: true, known: ['fs::read', 'web::fetch'], disabled: ['web::fetch'] },
      }),
      'tools'
    ).items
    expect(items[0]).toMatchObject({ label: 'read', detail: 'fs', state: 'available' })
    expect(items[1]).toMatchObject({ key: 'tools:disabled', detail: '1' })
  })

  it('is explicit that the exact chat request is not recorded', () => {
    expect(section(base(), 'payload').items[0].state).toBe('not-recorded')
  })
})
