import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { CustomChatTransport } from '../custom-chat-transport'

const h = vi.hoisted(() => ({
  fallbackModels: [] as string[],
  selectedProvider: 'llamacpp',
  selectedModel: { id: 'main' } as { id: string },
  providers: [
    { provider: 'llamacpp', models: [{ id: 'main' }, { id: 'local-b' }] },
    { provider: 'openai', models: [{ id: 'gpt' }] },
  ],
}))

vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: { getState: () => ({ fallbackModels: h.fallbackModels }) },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      selectedProvider: h.selectedProvider,
      selectedModel: h.selectedModel,
      providers: h.providers,
      getProviderByName: () => null,
    }),
  },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: null }) },
}))

type Seen = { model?: string; turnModel?: string }

class Harness extends CustomChatTransport {
  script: Array<() => Promise<ReadableStream<UIMessageChunk>>> = []
  seen: Seen[] = []
  carried: unknown[] = []
  announce: unknown = null
  turn() {
    return this.turnModel
  }
  protected override async sendOnce(): Promise<ReadableStream<UIMessageChunk>> {
    this.seen.push({
      model: this.getModelSelection().selectedModel?.id,
      turnModel: this.turnModel?.selectedModel?.id,
    })
    this.carried.push((this as unknown as { carriedCompaction: unknown }).carriedCompaction)
    ;(this as unknown as { sentCompaction: unknown }).sentCompaction = this.announce
    const next = this.script.shift()
    if (!next) throw new Error('script exhausted')
    return next()
  }
}

const chunk = (c: Record<string, unknown>) => c as unknown as UIMessageChunk

function streamOf(chunks: UIMessageChunk[], onCancel?: () => void) {
  let i = 0
  return new ReadableStream<UIMessageChunk>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else controller.close()
    },
    cancel: () => onCancel?.(),
  })
}

async function drain(stream: ReadableStream<UIMessageChunk>) {
  const out: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

const opening = [chunk({ type: 'start' }), chunk({ type: 'start-step' })]
const reply = [
  ...opening,
  chunk({ type: 'text-start', id: 't' }),
  chunk({ type: 'text-delta', id: 't', delta: 'hi' }),
  chunk({ type: 'text-end', id: 't' }),
  chunk({ type: 'finish-step' }),
  chunk({ type: 'finish' }),
]
const failure = (errorText: string) => [
  ...opening,
  chunk({ type: 'error', errorText }),
  chunk({ type: 'finish' }),
]
const options = (abortSignal?: AbortSignal) =>
  ({ chatId: 'c', messages: [], trigger: 'submit-message', abortSignal }) as never

describe('fallback chain in CustomChatTransport.sendMessages', () => {
  let t: Harness
  beforeEach(() => {
    h.fallbackModels = ['llamacpp::local-b']
    h.selectedProvider = 'llamacpp'
    h.selectedModel = { id: 'main' }
    t = new Harness('sys', 'thread-1')
  })

  it('with an empty chain returns sendOnce own stream untouched', async () => {
    h.fallbackModels = []
    const stream = streamOf(failure('Overloaded'))
    t.script = [async () => stream]
    expect(await t.sendMessages(options())).toBe(stream)
    expect(t.seen).toHaveLength(1)
  })

  it('also stays out of the way when every entry is the current model', async () => {
    h.fallbackModels = ['llamacpp::main']
    const stream = streamOf(reply)
    t.script = [async () => stream]
    expect(await t.sendMessages(options())).toBe(stream)
  })

  it('retries on an early error chunk, hides it, and cancels the first stream', async () => {
    const cancelled = vi.fn()
    t.script = [
      async () => streamOf(failure('Service Unavailable'), cancelled),
      async () => streamOf(reply),
    ]
    const out = await drain(await t.sendMessages(options()))
    expect(out).toEqual(reply)
    expect(t.seen.map((s) => s.model)).toEqual(['main', 'local-b'])
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('retries when sendOnce throws', async () => {
    t.script = [
      async () => {
        throw new Error('Failed to create model: Model main failed to load')
      },
      async () => streamOf(reply),
    ]
    expect(await drain(await t.sendMessages(options()))).toEqual(reply)
    expect(t.seen.map((s) => s.model)).toEqual(['main', 'local-b'])
  })

  it('walks the chain in order and surfaces the last failure when all fail', async () => {
    h.fallbackModels = ['llamacpp::local-b', 'openai::gpt']
    t.script = [
      async () => streamOf(failure('Overloaded')),
      async () => streamOf(failure('Overloaded')),
      async () => streamOf(failure('503 Service Unavailable')),
    ]
    const out = await drain(await t.sendMessages(options()))
    expect(t.seen.map((s) => s.model)).toEqual(['main', 'local-b', 'gpt'])
    expect(out.map((c) => c.type)).toEqual(['start', 'start-step', 'error', 'finish'])
    expect(out[2]).toMatchObject({ errorText: '503 Service Unavailable' })
  })

  it('rethrows a thrown error once the chain is used up', async () => {
    t.script = [
      async () => {
        throw new Error('Overloaded')
      },
      async () => {
        throw new Error('Overloaded again')
      },
    ]
    await expect(t.sendMessages(options())).rejects.toThrow('Overloaded again')
  })

  it('does not fall back after a stop', async () => {
    const controller = new AbortController()
    controller.abort()
    const chunks = failure('Overloaded')
    t.script = [async () => streamOf(chunks)]
    const out = await drain(await t.sendMessages(options(controller.signal)))
    expect(out).toEqual(chunks)
    expect(t.seen).toHaveLength(1)
  })

  it('does not fall back on an AbortError thrown while opening', async () => {
    const abort = new Error('Aborted')
    abort.name = 'AbortError'
    t.script = [
      async () => {
        throw abort
      },
    ]
    await expect(t.sendMessages(options())).rejects.toBe(abort)
    expect(t.seen).toHaveLength(1)
  })

  it('does not fall back once reply content has started', async () => {
    const chunks = [
      ...opening,
      chunk({ type: 'text-start', id: 't' }),
      chunk({ type: 'error', errorText: 'Overloaded' }),
    ]
    t.script = [async () => streamOf(chunks)]
    expect(await drain(await t.sendMessages(options()))).toEqual(chunks)
    expect(t.seen).toHaveLength(1)
  })

  it('does not fall back on a client error', async () => {
    const chunks = failure('HTTP 400 invalid request')
    t.script = [async () => streamOf(chunks)]
    expect(await drain(await t.sendMessages(options()))).toEqual(chunks)
    expect(t.seen).toHaveLength(1)
  })

  it('passes a tool-call-only reply through unchanged and in order', async () => {
    const chunks = [
      ...opening,
      chunk({ type: 'tool-input-start', toolCallId: 'a', toolName: 'read' }),
      chunk({ type: 'tool-input-delta', toolCallId: 'a', inputTextDelta: '{}' }),
      chunk({
        type: 'tool-input-available',
        toolCallId: 'a',
        toolName: 'read',
        input: {},
      }),
      chunk({ type: 'finish-step' }),
      chunk({ type: 'finish' }),
    ]
    t.script = [async () => streamOf(chunks)]
    expect(await drain(await t.sendMessages(options()))).toEqual(chunks)
    expect(t.seen).toHaveLength(1)
  })

  it('passes a reasoning-first reply through unchanged and in order', async () => {
    const chunks = [
      ...opening,
      chunk({ type: 'reasoning-start', id: 'r' }),
      chunk({ type: 'reasoning-delta', id: 'r', delta: 'hmm' }),
      chunk({ type: 'reasoning-end', id: 'r' }),
      chunk({ type: 'text-start', id: 't' }),
      chunk({ type: 'text-delta', id: 't', delta: 'ok' }),
      chunk({ type: 'text-end', id: 't' }),
      chunk({ type: 'finish' }),
    ]
    t.script = [async () => streamOf(chunks)]
    expect(await drain(await t.sendMessages(options()))).toEqual(chunks)
  })

  it('passes a stream that only ever opens through', async () => {
    t.script = [async () => streamOf(opening)]
    expect(await drain(await t.sendMessages(options()))).toEqual(opening)
  })

  it('moves only the request that failed: turnModel is restored, the next send starts on the chosen model', async () => {
    t.script = [
      async () => streamOf(failure('Overloaded')),
      async () => streamOf(reply),
      async () => streamOf(reply),
    ]
    const stream = await t.sendMessages(options())
    expect(t.turn()).toBeUndefined()
    expect(await drain(stream)).toEqual(reply)
    await drain(await t.sendMessages(options()))
    expect(t.seen.map((s) => s.model)).toEqual(['main', 'local-b', 'main'])
    // The retry saw the fallback as this turn's model, not the picker's.
    expect(t.seen[1].turnModel).toBe('local-b')
    expect(t.seen[2].turnModel).toBeUndefined()
  })

  it('keeps a model a router chose for the turn as the one to restore', async () => {
    const routed = {
      selectedProvider: 'llamacpp',
      selectedModel: h.providers[0].models[1],
    } as never
    ;(t as unknown as { turnModel: unknown }).turnModel = routed
    h.fallbackModels = ['llamacpp::main']
    t.script = [
      async () => streamOf(failure('Overloaded')),
      async () => streamOf(reply),
    ]
    await drain(await t.sendMessages(options()))
    expect(t.seen.map((s) => s.model)).toEqual(['local-b', 'main'])
    expect(t.turn()).toBe(routed)
  })

  it('hands a compaction the failed attempt made to the retry to announce', async () => {
    const record = { summarizedCount: 4 }
    t.announce = record
    t.script = [
      async () => streamOf(failure('Overloaded')),
      async () => streamOf(reply),
    ]
    await drain(await t.sendMessages(options()))
    expect(t.carried).toEqual([null, record])
    expect((t as unknown as { carriedCompaction: unknown }).carriedCompaction).toBeNull()
  })

  describe('credential failures', () => {
    const bad = () => failure('Failed to create model: Invalid API key')

    it('stay on the provider when the next model shares it', async () => {
      const chunks = bad()
      t.script = [async () => streamOf(chunks)]
      expect(await drain(await t.sendMessages(options()))).toEqual(chunks)
      expect(t.seen).toHaveLength(1)
    })

    it('do not hop to a same-provider model before a different one', async () => {
      h.fallbackModels = ['llamacpp::local-b', 'openai::gpt']
      t.script = [
        async () => streamOf(bad()),
        async () => streamOf(reply),
      ]
      const out = await drain(await t.sendMessages(options()))
      expect(out.map((c) => c.type)).toEqual(['start', 'start-step', 'error', 'finish'])
      expect(t.seen).toHaveLength(1)
    })

    it('reach a different provider when it is next in the chain', async () => {
      h.fallbackModels = ['openai::gpt']
      t.script = [async () => streamOf(bad()), async () => streamOf(reply)]
      expect(await drain(await t.sendMessages(options()))).toEqual(reply)
      expect(t.seen.map((s) => s.model)).toEqual(['main', 'gpt'])
    })

    it('a model that failed to start still falls back within a provider', async () => {
      t.script = [
        async () => {
          throw new Error('Failed to create model: engine exited with code 1')
        },
        async () => streamOf(reply),
      ]
      expect(await drain(await t.sendMessages(options()))).toEqual(reply)
    })
  })
})
