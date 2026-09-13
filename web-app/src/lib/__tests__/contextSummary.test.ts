import { describe, it, expect } from 'vitest'
import {
  evidenceFromSnapshot,
  summarizeChatContext,
  type ChatContextInput,
  type SnapshotEvidence,
} from '../contextSummary'
import type { RequestAttribution } from '../requestAttribution'

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

const memory = (over: Record<string, unknown> = {}) => ({
  block: '...',
  injectedIds: ['m1'],
  injectedHashes: ['h'],
  conflictIds: ['m2', 'm3'],
  droppedIds: ['m4'],
  charsUsed: 40,
  candidateIds: ['m1', 'm2', 'm3', 'm4', 'm5'],
  projectId: null,
  disabled: false,
  ...over,
})

const attribution = (over: Partial<RequestAttribution> = {}): RequestAttribution => ({
  v: 1,
  requestId: 'req-1',
  snapshotId: 'snap-1',
  snapshotHash: 'fnv:1',
  invocationId: 'inv-1',
  snapshotStatus: 'captured',
  assembledAt: '2026-09-13T10:00:00.000Z',
  memory: {
    injectedIds: ['m1'],
    injectedHashes: ['h'],
    conflictIds: [],
    droppedIds: [],
    candidateIds: ['m1'],
    projectId: null,
    projectName: null,
    disabled: false,
    temporary: false,
    unavailable: false,
  },
  tools: ['read'],
  attachments: { inline: [], availableViaSearch: [] },
  provider: 'llamacpp',
  model: 'qwen3-8b',
  sendState: 'response-started',
  usageReported: false,
  ...over,
})

const loaded = (system: string, tools: string[] = [], extra: object = {}): SnapshotEvidence =>
  evidenceFromSnapshot({
    payload: {
      messages: [{ role: 'system', content: system }, { role: 'user', content: 'hi' }],
      tools: tools.map((name) => ({ type: 'function', function: { name } })),
      ...extra,
    },
  })

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
      ['notes.txt', 'attached-to-message'],
      ['book.pdf', 'available-on-search'],
      ['old.pdf', 'available-on-search'],
    ])
    expect(items[0].action).toBe('remove-pending-attachment')
    // Retrieval is never claimed as inclusion.
    expect(items[2].reason).toBe('retrievalNotRecorded')
  })

  it('verifies an inline file only when its id is in the snapshot', () => {
    const input = (evidence: SnapshotEvidence) =>
      base({
        sentFiles: [{ id: 'file-123', name: 'notes.txt', injectionMode: 'inline' }],
        attribution: attribution(),
        evidence,
      })
    const withId = loaded('sys', [], {
      extra: '[ATTACHED_FILES] file_id: file-123 [/ATTACHED_FILES]',
    })
    expect(section(input(withId), 'attachments').items[0]).toMatchObject({
      state: 'included-last-request',
      reason: 'inlineVerified',
    })
    expect(section(input(loaded('sys')), 'attachments').items[0].state).toBe(
      'attached-to-message'
    )
  })

  describe('memory: retrieved, selected, included', () => {
    it('does not claim anything was sent before a request exists', () => {
      expect(section(base(), 'memory').items[0]).toMatchObject({
        state: 'not-recorded',
        reason: 'memoryNotSentYet',
      })
    })

    it('calls an injected memory selected, not included, without the snapshot', () => {
      const items = section(
        base({
          memory: memory(),
          memoryViews: [{ id: 'm1', scope: 'user', preview: 'Prefers metric units' } as never],
        }),
        'memory'
      ).items
      expect(items[0]).toMatchObject({
        label: 'Prefers metric units',
        state: 'selected-last-request',
        reason: 'memorySelectedUnverified',
        scope: 'across-chats',
      })
      expect(items.find((i) => i.key === 'memory:m5')).toMatchObject({
        state: 'retrieved',
        reason: 'memoryRetrievedNotChosen',
      })
      // Withheld candidates are summarised once, not also listed as retrieved.
      expect(items.find((i) => i.key === 'memory:m2')).toBeUndefined()
      expect(items.find((i) => i.key === 'memory:conflicts')?.state).toBe('not-offered')
      expect(items.find((i) => i.key === 'memory:dropped')?.detail).toBe('1')
    })

    it('calls it included only when its id is in the sanitized system prompt', () => {
      const included = section(
        base({
          memory: memory(),
          attribution: attribution(),
          evidence: loaded('# Remembered\n- [m1] (user) Prefers metric units'),
        }),
        'memory'
      ).items[0]
      expect(included).toMatchObject({
        state: 'included-last-request',
        reason: 'memoryIncludedVerified',
      })

      const missing = section(
        base({
          memory: memory(),
          attribution: attribution(),
          evidence: loaded('You are Jan.'),
        }),
        'memory'
      ).items[0]
      expect(missing).toMatchObject({
        state: 'selected-last-request',
        reason: 'memoryNotInSnapshot',
      })
    })

    it('never upgrades to included when the snapshot is unavailable', () => {
      for (const reason of ['not-captured', 'too-large', 'missing'] as const) {
        const item = section(
          base({
            memory: memory(),
            attribution: attribution(),
            evidence: { status: 'unavailable', reason },
          }),
          'memory'
        ).items[0]
        expect(item.state).toBe('selected-last-request')
      }
    })

    it('names the project a project memory came from', () => {
      const item = section(
        base({
          memory: memory({ projectId: 'jan-project:pA' }),
          memoryViews: [{ id: 'm1', scope: 'project', preview: 'Deploy with make ship' } as never],
          lastProjectName: 'Alpha',
          currentProject: { id: 'pA', name: 'Alpha' },
        }),
        'memory'
      ).items[0]
      expect(item).toMatchObject({ scope: 'project', detail: 'Alpha' })
    })

    it('says memory is off in a temporary chat', () => {
      expect(section(base({ temporary: true }), 'memory').items[0].reason).toBe('temporaryChat')
    })

    it('says memory is turned off rather than that nothing applied', () => {
      const items = section(base({ memory: memory({ disabled: true, injectedIds: [] }) }), 'memory')
        .items
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ key: 'memory:disabled', state: 'not-offered' })
    })

    it('explains an empty selection', () => {
      const s = section(
        base({
          memory: memory({ injectedIds: [], candidateIds: [], conflictIds: [], droppedIds: [] }),
        }),
        'memory'
      )
      expect(s.items).toHaveLength(0)
      expect(s.emptyReason).toBe('noMemory')
    })

    it('says the last request used the previous project after a move', () => {
      const s = section(
        base({
          memory: memory({ projectId: 'jan-project:pA' }),
          lastProjectName: 'Alpha',
          currentProject: { id: 'pB', name: 'Beta' },
        }),
        'memory'
      )
      expect(s.notices).toEqual([
        { key: 'projectChanged', values: { previous: 'Alpha', current: 'Beta' } },
      ])
    })

    it('says so when the project was deleted, and not when nothing changed', () => {
      const removed = section(
        base({
          memory: memory({ projectId: 'jan-project:pA' }),
          lastProjectName: 'Alpha',
          currentProject: null,
        }),
        'memory'
      )
      expect(removed.notices?.[0].values).toEqual({ previous: 'Alpha', current: null })
      const same = section(
        base({
          memory: memory({ projectId: 'jan-project:pA' }),
          currentProject: { id: 'pA', name: 'Alpha' },
        }),
        'memory'
      )
      expect(same.notices).toBeUndefined()
    })
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

  it('distinguishes advertised tools from tools verified in the request', () => {
    const tools = { modelSupportsTools: true, known: ['fs::read', 'fs::write'], disabled: [] }
    const advertised = section(base({ tools, attribution: attribution({ tools: ['read'] }) }), 'tools')
      .items
    expect(advertised[0]).toMatchObject({ label: 'read', state: 'selected-last-request' })
    expect(advertised[1]).toMatchObject({ label: 'write', state: 'available' })

    const verified = section(
      base({
        tools,
        attribution: attribution({ tools: ['read'] }),
        evidence: loaded('sys', ['read', 'web_search']),
      }),
      'tools'
    ).items
    expect(verified.find((i) => i.label === 'read')?.state).toBe('included-last-request')
    expect(verified.find((i) => i.label === 'write')).toMatchObject({
      state: 'available',
      reason: 'toolNotInLastRequest',
    })
    // A built-in tool in the request is listed too.
    expect(verified.find((i) => i.label === 'web_search')?.state).toBe('included-last-request')
  })

  describe('the last request', () => {
    it('says there is no request yet', () => {
      expect(section(base(), 'payload').items[0]).toMatchObject({
        state: 'not-recorded',
        reason: 'noRequestYet',
      })
      expect(section(base(), 'payload').snapshotId).toBeUndefined()
    })

    it('reports the send state and snapshot status, with the adapter boundary', () => {
      const s = section(
        base({ attribution: attribution({ usageReported: true }), evidence: loaded('x') }),
        'payload'
      )
      expect(s.items[0]).toMatchObject({
        state: 'response-started',
        reason: 'snapshotVerified',
        detail: 'llamacpp · qwen3-8b',
      })
      expect(s.items[1]).toMatchObject({ key: 'payload:usage', reason: 'usageRecorded' })
      expect(s.snapshotId).toBe('snap-1')
      expect(s.notices).toEqual([{ key: 'adapterBoundary' }])
    })

    it.each([
      [{ sendState: 'assembled', snapshotStatus: 'pending', snapshotId: null }, 'request-assembled', 'snapshotPending'],
      [{ sendState: 'sent', snapshotStatus: 'pending', snapshotId: null }, 'request-sent', 'snapshotPending'],
      [{ sendState: 'failed', snapshotStatus: 'pending', snapshotId: null }, 'request-failed', 'requestFailed'],
      [{ snapshotStatus: 'not-captured', snapshotId: null }, 'response-started', 'snapshotUnavailable.not-captured'],
    ] as const)('maps %o', (over, state, reason) => {
      const s = section(base({ attribution: attribution(over as never) }), 'payload')
      expect(s.items[0]).toMatchObject({ state, reason })
    })

    it('reports a snapshot that could not be read back', () => {
      const s = section(
        base({ attribution: attribution(), evidence: { status: 'unavailable', reason: 'too-large' } }),
        'payload'
      )
      expect(s.items[0].reason).toBe('snapshotUnavailable.too-large')
    })
  })
})

describe('evidenceFromSnapshot', () => {
  it('reads an OpenAI-compatible payload', () => {
    const e = loaded('# Remembered\n- [m1] x', ['read'])
    expect(e).toMatchObject({ status: 'loaded', toolNames: ['read'] })
    expect(e.status === 'loaded' && e.systemText).toContain('[m1]')
  })

  it('reads an Anthropic payload', () => {
    const e = evidenceFromSnapshot({
      payload: {
        system: [{ type: 'text', text: '- [m7] remembered' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [{ name: 'grep', input_schema: {} }],
      },
    })
    expect(e).toMatchObject({ status: 'loaded', toolNames: ['grep'] })
    expect(e.status === 'loaded' && e.systemText).toContain('[m7]')
  })

  it('reports an unavailable or missing snapshot', () => {
    expect(evidenceFromSnapshot({ payload: null, unavailable: 'too-large' })).toEqual({
      status: 'unavailable',
      reason: 'too-large',
    })
    expect(evidenceFromSnapshot(null)).toEqual({ status: 'unavailable', reason: 'missing' })
  })
})
