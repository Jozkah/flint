/**
 * A Cowork run that outgrows its window keeps going: the run loop compacts
 * between steps (and once more when the provider refuses a step for length)
 * instead of stopping at the window.
 */
import { describe, it, expect, vi } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'
import { runTurn, type ToolOutcome } from '../coworkRunner'
import {
  compactHistory,
  estimateHistoryTokens,
  hasUnresolvedToolCall,
  isSummaryMessage,
  shouldCompact,
  type CompactionRecord,
} from '../compaction'

const streamOf = (chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> =>
  new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk)
      c.close()
    },
  })

const toolStep = (id: string): UIMessageChunk[] => [
  { type: 'tool-input-start', toolCallId: id, toolName: 'read' } as UIMessageChunk,
  {
    type: 'tool-input-available',
    toolCallId: id,
    toolName: 'read',
    input: { path: `${id}.txt` },
  } as UIMessageChunk,
]

const textStep = (text: string): UIMessageChunk[] => [
  { type: 'text-delta', id: 't', delta: text } as UIMessageChunk,
]

const sink = () => ({
  onText: vi.fn(),
  onToolStart: vi.fn(),
  onToolArgsDelta: vi.fn(),
  onToolCall: vi.fn(),
})

const user = (text: string): UIMessage =>
  ({ id: 'u0', role: 'user', parts: [{ type: 'text', text }] }) as UIMessage

/** Every tool part sent to the model has its result beside it. */
const everyCallResolved = (messages: UIMessage[]) =>
  messages.every((m) => !hasUnresolvedToolCall(m))

describe('Cowork run crossing the compaction threshold', () => {
  it('compacts between steps and finishes instead of stopping', async () => {
    const WINDOW = 4_000
    // Each tool result is ~2,000 characters (~570 tokens): a handful of steps
    // crosses 80% of a 4,000-token window.
    const bigOutput = 'x'.repeat(2_000)
    const steps = [
      ...Array.from({ length: 10 }, (_, i) => toolStep(`c${i}`)),
      textStep('done'),
    ]
    let i = 0
    const sent: UIMessage[][] = []
    const sendStep = vi.fn(async (messages: UIMessage[]) => {
      sent.push(messages)
      // A provider with a hard window: a request past it is refused.
      if (estimateHistoryTokens(messages) > WINDOW) {
        throw new Error("This model's maximum context length is 4000 tokens")
      }
      return streamOf(steps[Math.min(i++, steps.length - 1)])
    })
    const records: CompactionRecord[] = []
    const summarize = vi.fn(async () => 'read c0..cN; nothing changed yet')
    const compact = vi.fn(
      async (messages: UIMessage[], why: 'threshold' | 'context-error') => {
        if (why === 'threshold' && !shouldCompact(estimateHistoryTokens(messages), WINDOW)) {
          return null
        }
        const result = await compactHistory(messages, {
          summarize,
          keepRecent: 2,
          reason: why,
        })
        if (!result) return null
        records.push(result.record)
        return result.messages
      }
    )

    const outcome = await runTurn({
      messages: [user('read every file and report')],
      signal: new AbortController().signal,
      deps: {
        sendStep,
        dispatch: vi.fn(async (): Promise<ToolOutcome> => ({ output: bigOutput })),
        sink: sink(),
        onStep: vi.fn(),
        nextMessageId: (() => {
          let n = 0
          return () => `m${n++}`
        })(),
        compact,
      },
    })

    expect(outcome.stoppedBy).toBe('done')
    expect(outcome.steps).toBe(11)
    // It compacted, more than once over a long run, and every request after
    // the first compaction carried the summary rather than the whole history.
    expect(records.length).toBeGreaterThanOrEqual(2)
    expect(records.every((r) => r.reason === 'threshold')).toBe(true)
    const afterFirst = sent.slice(-3)
    for (const request of afterFirst) {
      expect(request.some(isSummaryMessage)).toBe(true)
      expect(estimateHistoryTokens(request)).toBeLessThanOrEqual(WINDOW)
      expect(everyCallResolved(request)).toBe(true)
    }
    // Never more than one summary in a request: they fold, not stack.
    for (const request of sent) {
      expect(request.filter(isSummaryMessage).length).toBeLessThanOrEqual(1)
    }
    // The run's own history is the compacted one, so it is what is persisted.
    expect(outcome.messages.filter(isSummaryMessage)).toHaveLength(1)
    // The user's request survives the fold word for word.
    const summaryText = (
      outcome.messages.find(isSummaryMessage)!.parts[0] as { text: string }
    ).text
    expect(summaryText).toContain('read every file and report')
  })

  it('compacts and retries once when the provider refuses for length', async () => {
    const history: UIMessage[] = [
      user('first'),
      { id: 'a0', role: 'assistant', parts: [{ type: 'text', text: 'one' }] } as UIMessage,
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'second' }] } as UIMessage,
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'two' }] } as UIMessage,
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'third' }] } as UIMessage,
    ]
    let calls = 0
    const sendStep = vi.fn(async (messages: UIMessage[]) => {
      calls += 1
      if (!messages.some(isSummaryMessage)) {
        throw new Error('prompt is too long: 9000 tokens > 8192 maximum')
      }
      return streamOf(textStep('ok'))
    })
    const compact = vi.fn(async (messages: UIMessage[], why: string) => {
      if (why !== 'context-error') return null
      return (
        await compactHistory(messages, {
          summarize: async () => 'earlier: first, second',
          keepRecent: 1,
          reason: 'context-error',
        })
      )?.messages ?? null
    })

    const outcome = await runTurn({
      messages: history,
      signal: new AbortController().signal,
      deps: {
        sendStep,
        dispatch: vi.fn(),
        sink: sink(),
        onStep: vi.fn(),
        nextMessageId: () => 'm',
        compact,
      },
    })

    expect(outcome.stoppedBy).toBe('done')
    expect(calls).toBe(2)
    // The refusal itself comes along, so the window it names can be learned.
    expect(compact).toHaveBeenCalledWith(
      expect.any(Array),
      'context-error',
      expect.anything(),
      expect.any(Error)
    )
  })

  it('retries only once: a second refusal ends the run as an error', async () => {
    const sendStep = vi.fn(async () => {
      throw new Error("This model's maximum context length is 8192 tokens")
    })
    const compact = vi.fn(async (messages: UIMessage[], why: string) =>
      why === 'context-error' ? [...messages] : null
    )
    const outcome = await runTurn({
      messages: [user('hi')],
      signal: new AbortController().signal,
      deps: {
        sendStep,
        dispatch: vi.fn(),
        sink: sink(),
        onStep: vi.fn(),
        nextMessageId: () => 'm',
        compact,
      },
    })
    expect(outcome.stoppedBy).toBe('error')
    expect(compact.mock.calls.filter((c) => c[1] === 'context-error')).toHaveLength(1)
  })

  it('with compaction off, a refusal ends the run as before', async () => {
    const sendStep = vi.fn(async () => {
      throw new Error("This model's maximum context length is 8192 tokens")
    })
    const sent: UIMessage[][] = []
    sendStep.mockImplementation(async (...args: unknown[]) => {
      sent.push(args[0] as UIMessage[])
      throw new Error("This model's maximum context length is 8192 tokens")
    })
    const outcome = await runTurn({
      messages: [user('hi')],
      signal: new AbortController().signal,
      deps: {
        sendStep,
        dispatch: vi.fn(),
        sink: sink(),
        onStep: vi.fn(),
        nextMessageId: () => 'm',
      },
    })
    expect(outcome.stoppedBy).toBe('error')
    // Whatever the generic retry did, nothing was compacted.
    expect(sent.every((request) => !request.some(isSummaryMessage))).toBe(true)
  })
})

describe('Cowork allowance after compaction', () => {
  const stepWithUsage = (
    chunks: UIMessageChunk[],
    usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  ): UIMessageChunk[] => [
    ...chunks,
    { type: 'finish', messageMetadata: { usage } } as UIMessageChunk,
  ]

  const run = (withCompaction: boolean) => {
    const steps = [
      stepWithUsage(toolStep('c0'), {
        inputTokens: 1_000,
        outputTokens: 10,
        totalTokens: 1_010,
      }),
      stepWithUsage(textStep('done'), {
        inputTokens: 300,
        outputTokens: 5,
        totalTokens: 305,
      }),
    ]
    let i = 0
    let compacted = false
    return runTurn({
      messages: [user('y'.repeat(8_000))],
      signal: new AbortController().signal,
      deps: {
        sendStep: vi.fn(async () => streamOf(steps[i++])),
        dispatch: vi.fn(async (): Promise<ToolOutcome> => ({ output: 'ok' })),
        sink: sink(),
        onStep: vi.fn(),
        nextMessageId: (() => {
          let n = 0
          return () => `m${n++}`
        })(),
        compact: withCompaction
          ? vi.fn(async (messages: UIMessage[]) => {
              // Once, after the first step: the history shrinks to a summary.
              if (compacted || messages.length < 2) return null
              compacted = true
              return [
                {
                  id: 's',
                  role: 'user',
                  parts: [{ type: 'text', text: 'summary of the work so far' }],
                } as UIMessage,
              ]
            })
          : undefined,
      },
    })
  }

  // The 200k allowance counts the prompt once. Compaction removed the older
  // part of it, so the counted prompt becomes the compacted one instead of
  // staying at its pre-compaction size.
  it('credits the summarized part instead of staying cumulative', async () => {
    const without = await run(false)
    const withIt = await run(true)
    expect(without.sessionTokens).toBe(1_015)
    // 1,010 charged, the 1,000-token prompt credited back to the summary's
    // size, then the next step's 300-token prompt and 5 new tokens.
    expect(withIt.sessionTokens).toBe(315)
  })
})

describe('Cowork allowance with auto-compact on', () => {
  const usageStep = (
    chunks: UIMessageChunk[],
    inputTokens: number,
    outputTokens: number
  ): UIMessageChunk[] => [
    ...chunks,
    {
      type: 'finish',
      messageMetadata: {
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      },
    } as UIMessageChunk,
  ]

  // The first step sets the baseline (150k); the second adds 80k of prompt and
  // a 5k completion, which is past the default 200k allowance.
  const steps = () => [
    usageStep(toolStep('c0'), 150_000, 100),
    usageStep(toolStep('c1'), 230_000, 5_000),
    usageStep(textStep('done'), 240_000, 100),
  ]

  const run = (extra: { sessionTokenLimit?: number }) => {
    const queue = steps()
    let i = 0
    return runTurn({
      messages: [user('go')],
      signal: new AbortController().signal,
      ...extra,
      deps: {
        sendStep: vi.fn(async () => streamOf(queue[i++])),
        dispatch: vi.fn(async (): Promise<ToolOutcome> => ({ output: 'ok' })),
        sink: sink(),
        onStep: vi.fn(),
        nextMessageId: (() => {
          let n = 0
          return () => `m${n++}`
        })(),
      },
    })
  }

  it('stops at the default allowance when none is given', async () => {
    expect((await run({})).stoppedBy).toBe('tokens')
  })

  it('a larger allowance lets the run reach its answer', async () => {
    expect((await run({ sessionTokenLimit: 800_000 })).stoppedBy).toBe('done')
  })
})

describe('Cowork compaction headroom', () => {
  const usageStep = (
    chunks: UIMessageChunk[],
    inputTokens: number
  ): UIMessageChunk[] => [
    ...chunks,
    {
      type: 'finish',
      messageMetadata: {
        usage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 },
      },
    } as UIMessageChunk,
  ]

  it('hands compact the recent per-step prompt growth, with a margin', async () => {
    const queue = [
      usageStep(toolStep('c0'), 1_000),
      usageStep(toolStep('c1'), 1_400), // grew 400
      usageStep(toolStep('c2'), 3_400), // grew 2,000
      usageStep(textStep('done'), 3_500),
    ]
    let i = 0
    const headrooms: Array<number | undefined> = []
    const compact = vi.fn(
      async (
        _m: UIMessage[],
        why: string,
        _s: AbortSignal,
        _f?: unknown,
        headroom?: number
      ) => {
        if (why === 'threshold') headrooms.push(headroom)
        return null
      }
    )
    await runTurn({
      messages: [user('go')],
      signal: new AbortController().signal,
      deps: {
        sendStep: vi.fn(async () => streamOf(queue[i++])),
        dispatch: vi.fn(async (): Promise<ToolOutcome> => ({ output: 'ok' })),
        sink: sink(),
        onStep: vi.fn(),
        nextMessageId: () => 'm',
        compact,
      },
    })
    // Asked before each of the four steps. No growth is known until two
    // prompts have been seen; then 1.25 x the largest recent growth.
    expect(headrooms).toEqual([undefined, undefined, 500, 2_500])
  })
})
