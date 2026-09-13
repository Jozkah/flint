/**
 * Request attribution for ordinary chat, driven through the real provider
 * fetch with the Tauri bridge stubbed: the send states come from the transport's
 * own events and the snapshot reference from its response head, exactly as in
 * the app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { UIMessage } from 'ai'

const invoke = vi.fn()
class FakeChannel<T> {
  onmessage: ((m: T) => void) | null = null
}
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: FakeChannel,
}))

const { providerFetch } = await import('@/lib/providerFetch')
const {
  AttributionRegistry,
  assembleAttribution,
  attributionMetadata,
  attributionOf,
  bindUsageAtFinish,
} = await import('@/lib/requestAttribution')

type Chunk = Record<string, unknown>

function drive() {
  const channels: FakeChannel<Chunk>[] = []
  invoke.mockImplementation(async (cmd: string, args: { channel?: FakeChannel<Chunk> }) => {
    if (cmd === 'provider_http_stream' && args.channel) channels.push(args.channel)
    return undefined
  })
  return {
    send: async (c: Chunk, index = 0) => {
      for (let i = 0; !channels[index] && i < 50; i++) await Promise.resolve()
      channels[index]?.onmessage?.(c)
    },
    request: (index = 0) =>
      invoke.mock.calls.filter((c) => c[0] === 'provider_http_stream')[index][1].request,
  }
}

const head = (snapshot: unknown) => ({
  kind: 'head',
  status: 200,
  statusText: 'OK',
  headers: {},
  peer: null,
  snapshot,
})

const dispatch = (run: string, session = 't1') =>
  providerFetch('http://127.0.0.1:1337/v1/chat/completions', {
    method: 'POST',
    headers: { 'x-jan-session': session, 'x-jan-run': run },
    body: JSON.stringify({ model: 'm', messages: [] }),
  })

const messages = [
  {
    id: 'u1',
    role: 'user',
    parts: [
      {
        type: 'text',
        text: 'Summarise\n[ATTACHED_FILES]\n- file_id: f-inline, name: notes.txt, mode: inline\n- file_id: f-rag, name: book.pdf, mode: embeddings\n[/ATTACHED_FILES]',
      },
    ],
  },
] as UIMessage[]

const assembled = (requestId: string) =>
  assembleAttribution({
    requestId,
    memory: {
      block: '# Remembered\n- [mem-1] (user) SECRET-MEMORY-CONTENT',
      injectedIds: ['mem-1'],
      injectedHashes: ['fnv:1'],
      conflictIds: ['mem-2', 'mem-3'],
      droppedIds: ['mem-4'],
      charsUsed: 20,
      candidateIds: ['mem-1', 'mem-5'],
      projectId: 'jan-project:pA',
      disabled: false,
    },
    binding: { temporary: false, janProjectId: 'pA', janProjectName: 'Alpha' },
    tools: ['read', 'web_search'],
    messages,
    provider: 'llamacpp',
    model: 'qwen3-8b',
    now: new Date('2026-09-13T10:00:00Z'),
  })

let registry: InstanceType<typeof AttributionRegistry>

beforeEach(() => {
  invoke.mockReset()
  registry = new AttributionRegistry()
})
afterEach(() => registry.stop())

describe('the assembled record', () => {
  it('names what went in by id, never by content', () => {
    const record = assembled('req-1')
    expect(record).toMatchObject({
      sendState: 'assembled',
      snapshotStatus: 'pending',
      assembledAt: '2026-09-13T10:00:00.000Z',
      memory: {
        injectedIds: ['mem-1'],
        injectedHashes: ['fnv:1'],
        conflictIds: ['mem-2', 'mem-3'],
        droppedIds: ['mem-4'],
        candidateIds: ['mem-1', 'mem-5'],
        projectId: 'jan-project:pA',
        projectName: 'Alpha',
      },
      tools: ['read', 'web_search'],
      attachments: { inline: ['f-inline'], availableViaSearch: ['f-rag'] },
      provider: 'llamacpp',
      model: 'qwen3-8b',
    })
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('SECRET-MEMORY-CONTENT')
    expect(serialized).not.toContain('Summarise')
  })

  it('reads back off persisted message metadata', () => {
    const record = assembled('req-1')
    expect(attributionOf({ metadata: { attribution: record } })).toEqual(record)
    expect(attributionOf({ metadata: { attribution: { v: 2 } } })).toBeNull()
    expect(attributionOf({ metadata: {} })).toBeNull()
  })
})

describe('send states from the dispatch', () => {
  it('moves assembled -> sent -> response-started and picks up the snapshot', async () => {
    const d = drive()
    registry.begin('t1', assembled('req-1'))
    const response = dispatch('req-1')
    await vi.waitFor(() => expect(registry.get('req-1')?.sendState).toBe('sent'))
    const invocation = d.request().invocationId as string
    expect(registry.get('req-1')?.invocationId).toBe(invocation)
    // The run header is for the transport and does not reach the provider.
    expect(d.request().run).toBe('req-1')
    expect(d.request().headers['x-jan-run']).toBeUndefined()

    await d.send(head({ id: 'snap-9', hash: 'fnv1a64:ab', redactions: 0, invocation }))
    await response
    expect(registry.get('req-1')).toMatchObject({
      sendState: 'response-started',
      snapshotId: 'snap-9',
      snapshotHash: 'fnv1a64:ab',
      snapshotStatus: 'captured',
      invocationId: invocation,
    })
  })

  it('records that no snapshot was captured rather than inventing one', async () => {
    const d = drive()
    registry.begin('t1', assembled('req-1'))
    const response = dispatch('req-1')
    await d.send(head(null))
    await response
    expect(registry.get('req-1')).toMatchObject({
      sendState: 'response-started',
      snapshotId: null,
      snapshotStatus: 'not-captured',
    })
  })

  it('marks a request that failed before the provider answered', async () => {
    const d = drive()
    registry.begin('t1', assembled('req-1'))
    const response = dispatch('req-1')
    await d.send({ kind: 'error', message: 'connection refused' })
    await expect(response).rejects.toThrow('connection refused')
    expect(registry.get('req-1')?.sendState).toBe('failed')
  })

  it("never updates one request from another request's traffic", async () => {
    const d = drive()
    registry.begin('t1', assembled('req-1'))
    registry.begin('t2', assembled('req-2'))
    const response = dispatch('req-2', 't2')
    await d.send(head({ id: 'snap-2', hash: 'h', redactions: 0, invocation: 'inv' }))
    await response
    expect(registry.get('req-1')).toMatchObject({ sendState: 'assembled', snapshotId: null })
    expect(registry.get('req-2')?.snapshotId).toBe('snap-2')
    expect(registry.latest('t1')?.requestId).toBe('req-1')
  })
})

describe('what is written onto the assistant message', () => {
  it('carries the snapshot reference from the sink into the message metadata', async () => {
    const d = drive()
    registry.begin('t1', assembled('req-1'))
    expect(attributionMetadata(registry, 'req-1', 'start')?.attribution.snapshotId).toBeNull()

    const response = dispatch('req-1')
    await d.send(head({ id: 'snap-9', hash: 'h', redactions: 0, invocation: 'inv-1' }))
    await response

    expect(attributionMetadata(registry, 'req-1', 'start-step')?.attribution).toMatchObject({
      snapshotId: 'snap-9',
      sendState: 'response-started',
    })
    // Text parts do not repeat it.
    expect(attributionMetadata(registry, 'req-1', 'text-delta')).toBeUndefined()
  })

  it('binds provider usage at finish to the invocation, and says so', async () => {
    const d = drive()
    registry.begin('t1', assembled('req-1'))
    const response = dispatch('req-1')
    await d.send(head({ id: 'snap-9', hash: 'h9', redactions: 0, invocation: 'inv-1' }))
    await response

    const record = vi.fn().mockResolvedValue(true)
    const bound = bindUsageAtFinish({
      registry,
      requestId: 'req-1',
      session: 't1',
      model: 'qwen3-8b',
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      record,
    })
    expect(bound).toBe(true)
    expect(record).toHaveBeenCalledWith({
      session: 't1',
      run: 'req-1',
      snapshot: { id: 'snap-9', hash: 'h9', redactions: 0, invocation: 'inv-1' },
      model: 'qwen3-8b',
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    })
    expect(attributionMetadata(registry, 'req-1', 'finish')?.attribution.usageReported).toBe(true)
  })

  it('does not file usage for a request that never reached the transport', () => {
    registry.begin('t1', assembled('req-1'))
    const record = vi.fn()
    expect(
      bindUsageAtFinish({
        registry,
        requestId: 'req-1',
        session: 't1',
        model: 'm',
        usage: { inputTokens: 1 },
        record,
      })
    ).toBe(false)
    expect(record).not.toHaveBeenCalled()
  })
})
