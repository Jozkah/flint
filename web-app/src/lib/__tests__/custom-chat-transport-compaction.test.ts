import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'

const h = vi.hoisted(() => ({
  summaries: [] as string[],
  summarizer: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { info: vi.fn(), warning: vi.fn() } }))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: { getState: () => ({ fallbackModels: [] }) },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      selectedProvider: 'llamacpp',
      selectedModel: { id: 'main' },
      providers: [{ provider: 'llamacpp', models: [{ id: 'main' }] }],
      getProviderByName: () => null,
    }),
  },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: null }) },
}))
vi.mock('@/lib/toolActivity', () => ({
  recordLifecycle: vi.fn(async () => {}),
}))
vi.mock('@/lib/compactionSummarizer', () => ({
  modelSummarizer: () => async (transcript: string) => {
    h.summarizer(transcript)
    return '<summary>gist</summary>'
  },
}))

import { toast } from 'sonner'
import { CustomChatTransport } from '../custom-chat-transport'
import {
  CompactionLoopError,
  recordCompaction,
  resetCompactionBreaker,
} from '../compactionGuard'
import { readChatCompaction, writeChatCompaction } from '../chatCompaction'
import { estimateHistoryTokens, isSummaryMessage } from '../compaction'

const text = (id: string, role: UIMessage['role'], body: string): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: body }] }) as UIMessage

const toolResult = (id: string, chars: number): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [
      {
        type: 'tool-read',
        toolCallId: `call-${id}`,
        input: {},
        state: 'output-available',
        output: 'x'.repeat(chars),
      },
    ],
  }) as unknown as UIMessage

type Threshold = (
  threadId: string,
  messages: UIMessage[],
  opts: Record<string, unknown>
) => Promise<UIMessage[]>

class Harness extends CustomChatTransport {
  run(threadId: string, messages: UIMessage[], opts: Record<string, unknown>) {
    const fn = (
      this as unknown as { compactAtThreshold: Threshold }
    ).compactAtThreshold.bind(this)
    return fn(threadId, messages, {
      window: 20_000,
      trimReserveTokens: 3_000,
      systemPromptTokens: 0,
      keepRecent: 8,
      summaryMaxTokens: 512,
      provider: 'llamacpp',
      modelId: 'main',
      session: threadId,
      ...opts,
    })
  }
}

const sizeOf = (messages: UIMessage[]) => estimateHistoryTokens(messages)

describe('Chat compaction on a tool loop', () => {
  let t: Harness
  let n = 0
  let thread: string
  beforeEach(() => {
    h.summarizer.mockClear()
    t = new Harness('sys', 'thread-1')
    thread = `th-${++n}`
    resetCompactionBreaker(thread)
  })

  it('leaves a request under the trigger alone', async () => {
    const messages = [text('u0', 'user', 'hi'), text('a0', 'assistant', 'hello')]
    expect(await t.run(thread, messages, {})).toBe(messages)
    expect(h.summarizer).not.toHaveBeenCalled()
  })

  it('folds the middle of a long single-turn loop, not only earlier turns', async () => {
    // An earlier exchange, then one user turn that became 20 tool waves.
    const messages: UIMessage[] = [
      text('u0', 'user', 'earlier'),
      text('a0', 'assistant', 'earlier answer'),
      text('u1', 'user', 'do the long task'),
      ...Array.from({ length: 20 }, (_, i) => toolResult(`w${i}`, 10_000)),
    ]
    expect(sizeOf(messages)).toBeGreaterThan(20_000)
    const out = await t.run(thread, messages, {})
    expect(sizeOf(out)).toBeLessThan(14_000)
    expect(isSummaryMessage(out[0])).toBe(true)
    // The user's request travels with the summary, word for word.
    expect(JSON.stringify(out[0])).toContain('do the long task')
    // The cut that kept the whole loop was skipped without a summary call, so
    // exactly one model call paid for the compaction.
    expect(h.summarizer).toHaveBeenCalledTimes(1)
    // And the boundary is kept, so the next request reuses the summary.
    expect(readChatCompaction(thread)?.boundaryId).toBe(out[1].id)
  })

  it('shrinks a single huge tool result that no summary can fold', async () => {
    const messages: UIMessage[] = [
      text('u0', 'user', 'read it'),
      toolResult('big', 300_000),
    ]
    const out = await t.run(thread, messages, {})
    expect(sizeOf(out)).toBeLessThan(20_000 - 3_000)
    const kept = out.find((m) => m.id === 'big')!
    expect(JSON.stringify(kept)).toContain('left out to fit the context window')
    // The request the user made is not lost with it.
    expect(JSON.stringify(out)).toContain('read it')
  })

  it('compacts a request the provider refused even though the estimate fits', async () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      text(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`)
    )
    const out = await t.run(thread, messages, { force: true })
    expect(h.summarizer).toHaveBeenCalled()
    expect(isSummaryMessage(out[0])).toBe(true)
    expect(out.length).toBeLessThan(messages.length)
  })

  it('goes harder instead of stopping when the conversation refills right after a compaction', async () => {
    // Two rapid refills in a row: the breaker is armed for this history size.
    recordCompaction(thread, 100, 20)
    recordCompaction(thread, 22, 21)
    const messages: UIMessage[] = [
      text('u0', 'user', 'earlier'),
      text('a0', 'assistant', 'earlier answer'),
      text('u1', 'user', 'do the long task'),
      ...Array.from({ length: 19 }, (_, i) => toolResult(`w${i}`, 10_000)),
    ]
    expect(messages.length).toBe(22)
    const out = await t.run(thread, messages, {})
    expect(sizeOf(out)).toBeLessThan(20_000)
    expect(isSummaryMessage(out[0])).toBe(true)
  })

  it('stops with the loop error only when nothing at all can be done', async () => {
    recordCompaction(thread, 10, 1)
    recordCompaction(thread, 2, 1)
    // One message of plain text that is itself over the window.
    const messages = [text('u0', 'user', 'y'.repeat(200_000))]
    await expect(t.run(thread, messages, {})).rejects.toBeInstanceOf(
      CompactionLoopError
    )
  })

  it('forgets a summary whose boundary message is gone', async () => {
    writeChatCompaction(thread, {
      record: { summarizedCount: 2, summary: 's', at: 1, reason: 'threshold' },
      boundaryId: 'gone',
      latestRequest: null,
    })
    const messages = [text('u0', 'user', 'hi'), text('a0', 'assistant', 'yo')]
    await t.run(thread, messages, {})
    expect(readChatCompaction(thread)).toBeNull()
  })
})

// Streams for the refusal-and-resend path.
const chunk = (c: Record<string, unknown>) => c as unknown as UIMessageChunk
const streamOf = (chunks: UIMessageChunk[]) => {
  let i = 0
  return new ReadableStream<UIMessageChunk>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else controller.close()
    },
  })
}
const drain = async (stream: ReadableStream<UIMessageChunk>) => {
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
const refusal = (message: string) => [
  ...opening,
  chunk({ type: 'error', errorText: message }),
  chunk({ type: 'finish' }),
]
const options = (abortSignal?: AbortSignal) =>
  ({ chatId: 'c', messages: [], trigger: 'submit-message', abortSignal }) as never

class Scripted extends CustomChatTransport {
  script: Array<() => Promise<ReadableStream<UIMessageChunk>>> = []
  retryWindows: Array<unknown> = []
  protected override async sendOnce(): Promise<ReadableStream<UIMessageChunk>> {
    this.retryWindows.push(
      (this as unknown as { overflowRetry: unknown }).overflowRetry
    )
    const next = this.script.shift()
    if (!next) throw new Error('script exhausted')
    return next()
  }
}

describe('compact once and resend when the provider refuses for length', () => {
  const overflow =
    'request (30000 tokens) exceeds the available context size (20000 tokens)'
  let t: Scripted
  beforeEach(() => {
    t = new Scripted('sys', 'thread-1')
  })

  it('swallows an early refusal and carries on with the resent stream', async () => {
    t.script = [async () => streamOf(refusal(overflow)), async () => streamOf(reply)]
    const out = await drain(await t.sendMessages(options()))
    // The opening chunks went out once; the refusal never reached the chat.
    expect(out).toEqual(reply)
    expect(t.retryWindows).toEqual([null, { learnedWindow: 20000 }])
  })

  it('resends when the refusal is thrown rather than streamed', async () => {
    t.script = [
      async () => {
        throw new Error('This model\'s maximum context length is 8192 tokens')
      },
      async () => streamOf(reply),
    ]
    expect(await drain(await t.sendMessages(options()))).toEqual(reply)
    expect(t.retryWindows).toHaveLength(2)
  })

  it('resends only once, then shows the refusal', async () => {
    t.script = [
      async () => streamOf(refusal(overflow)),
      async () => streamOf(refusal(overflow)),
      async () => streamOf(reply),
    ]
    const out = await drain(await t.sendMessages(options()))
    expect(out.some((c) => c.type === 'error')).toBe(true)
    expect(t.script).toHaveLength(1)
  })

  it('recovers when reading the response throws a context error', async () => {
    t.script = [
      async () => new ReadableStream<UIMessageChunk>({
        start(controller) { controller.error(new Error(overflow)) },
      }),
      async () => streamOf(reply),
    ]
    expect(await drain(await t.sendMessages(options()))).toEqual(reply)
    expect(t.retryWindows).toEqual([null, { learnedWindow: 20000 }])
  })

  it('does not retry a reader failure after reply content', async () => {
    let at = 0
    t.script = [
      async () => new ReadableStream<UIMessageChunk>({
        pull(controller) {
          if (at < 3) controller.enqueue(reply[at++])
          else controller.error(new Error(overflow))
        },
      }),
      async () => streamOf(reply),
    ]
    await expect(drain(await t.sendMessages(options()))).rejects.toThrow(overflow)
    expect(t.retryWindows).toHaveLength(1)
  })

  it('leaves other failures alone', async () => {
    t.script = [async () => streamOf(refusal('Overloaded')), async () => streamOf(reply)]
    const out = await drain(await t.sendMessages(options()))
    expect(out).toEqual(refusal('Overloaded'))
    expect(t.retryWindows).toHaveLength(1)
  })

  it('does not resend a request the user stopped', async () => {
    const controller = new AbortController()
    controller.abort()
    t.script = [async () => streamOf(refusal(overflow)), async () => streamOf(reply)]
    const out = await drain(await t.sendMessages(options(controller.signal)))
    expect(out.some((c) => c.type === 'error')).toBe(true)
    expect(t.retryWindows).toHaveLength(1)
  })

  it('does not take back a reply that already began', async () => {
    const midStream = [
      ...opening,
      chunk({ type: 'text-start', id: 't' }),
      chunk({ type: 'error', errorText: overflow }),
    ]
    t.script = [async () => streamOf(midStream), async () => streamOf(reply)]
    expect(await drain(await t.sendMessages(options()))).toEqual(midStream)
    expect(t.retryWindows).toHaveLength(1)
  })

  it('hands on what the resend announced, such as a compaction', async () => {
    const withMetadata = [
      chunk({ type: 'start', messageMetadata: { compaction: { at: 1 } } }),
      ...reply.slice(1),
    ]
    t.script = [async () => streamOf(refusal(overflow)), async () => streamOf(withMetadata)]
    const out = await drain(await t.sendMessages(options()))
    expect(out.filter((c) => c.type === 'start')).toHaveLength(1)
    expect(out).toContainEqual({
      type: 'message-metadata',
      messageMetadata: { compaction: { at: 1 } },
    })
    expect(out.some((c) => c.type === 'error')).toBe(false)
  })
})

describe('auto-compact with no window to plan against', () => {
  it('says so once per chat and model, not on every request', () => {
    const warning = vi.mocked(toast.warning)
    warning.mockClear()
    const t = new Harness('sys', 'thread-notice')
    const notice = (
      t as unknown as {
        noticeUnknownWindow: (thread: string, model: string) => void
      }
    ).noticeUnknownWindow.bind(t)
    notice('thread-notice', 'custom-model')
    notice('thread-notice', 'custom-model')
    expect(warning).toHaveBeenCalledTimes(1)
    notice('thread-notice', 'another-model')
    expect(warning).toHaveBeenCalledTimes(2)
  })
})
