import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'
import { runTurn, type ToolOutcome } from '../coworkRunner'
import { useMessageQueue } from '@/stores/message-queue-store'
import { envelopeToQueued } from '../mailboxDelivery'
import type { MailEnvelope } from '../sessionMailbox'

/**
 * Mail enters a run only through the queue, and the runner drains the queue
 * only at its two safe boundaries. These tests drive `runTurn` with a fake
 * model that asks for a tool while a message arrives mid-call.
 */
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
    input: { path: 'a.txt' },
  } as UIMessageChunk,
]
const textStep = (text: string): UIMessageChunk[] => [
  { type: 'text-delta', id: 't', delta: text } as UIMessageChunk,
]

const envelope = (id: string): MailEnvelope => ({
  v: 1,
  id,
  from: { sessionId: 'S1', displayName: 'Other' },
  to: { sessionId: 'A' },
  project: 'p',
  text: `mail ${id}`,
  createdAt: 1,
  depth: 0,
  origin: 'agent',
})

/** The route's `takeSteering`, minus the transcript write. */
const takeSteering = vi.fn(() =>
  useMessageQueue
    .getState()
    .takeReady('A')
    .map(
      (m) =>
        ({ id: `steer-${m.id}`, role: 'user', parts: [{ type: 'text', text: m.text }] }) as UIMessage
    )
)

const textOf = (m: UIMessage) =>
  (m.parts as { type: string; text?: string }[])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')

const hasToolOutput = (m: UIMessage) =>
  (m.parts as { type: string; state?: string }[]).some(
    (p) => p.type.startsWith('tool-') && p.state === 'output-available'
  )

describe('mailbox messages in a running turn', () => {
  beforeEach(() => {
    useMessageQueue.setState({ queues: {} })
    takeSteering.mockClear()
  })

  it('arriving between a tool call and its result enters only after the result', async () => {
    let takenAtDispatch = -1
    const dispatch = vi.fn(async (): Promise<ToolOutcome> => {
      // The message lands while the tool is running.
      useMessageQueue.getState().enqueue('A', envelopeToQueued(envelope('m1'), false))
      takenAtDispatch = takeSteering.mock.calls.length
      await new Promise((r) => setTimeout(r, 0))
      // Still queued: nothing drained it mid-call.
      expect(useMessageQueue.getState().getQueue('A')).toHaveLength(1)
      return { output: 'file contents' }
    })
    const steps = [toolStep('c1'), textStep('done')]
    let i = 0
    const sendStep = vi.fn(async () => streamOf(steps[Math.min(i++, steps.length - 1)]))
    const out = await runTurn({
      messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'go' }] } as UIMessage],
      signal: new AbortController().signal,
      deps: {
        sendStep,
        dispatch,
        sink: { onText: vi.fn(), onToolStart: vi.fn(), onToolArgsDelta: vi.fn(), onToolCall: vi.fn() },
        onStep: vi.fn(),
        nextMessageId: (() => {
          let n = 0
          return () => `m${n++}`
        })(),
        takeSteering,
      },
    } as never)

    expect(out.stoppedBy).toBe('done')
    // Offered once before the first request; not again while the call ran.
    expect(takenAtDispatch).toBe(1)
    const second = (sendStep.mock.calls[1] as unknown as [UIMessage[]])[0]
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    // The assistant message carries the call *and* its result, and the mail
    // follows it: never between them.
    expect(hasToolOutput(second[1])).toBe(true)
    expect(textOf(second[2])).toMatch(/^\[Coordination message from session "Other"/)
    expect(textOf(second[2])).toContain('mail m1')
    expect(useMessageQueue.getState().getQueue('A')).toEqual([])
  })

  it('arriving while the final answer streams continues the run after that answer', async () => {
    const steps = [textStep('answer'), textStep('reply to mail')]
    let i = 0
    const sendStep = vi.fn(async () => {
      if (i === 0) {
        useMessageQueue.getState().enqueue('A', envelopeToQueued(envelope('m2'), false))
      }
      return streamOf(steps[Math.min(i++, steps.length - 1)])
    })
    const out = await runTurn({
      messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'go' }] } as UIMessage],
      signal: new AbortController().signal,
      deps: {
        sendStep,
        dispatch: vi.fn(),
        sink: { onText: vi.fn(), onToolStart: vi.fn(), onToolArgsDelta: vi.fn(), onToolCall: vi.fn() },
        onStep: vi.fn(),
        nextMessageId: () => 'x',
        takeSteering,
      },
    } as never)
    expect(sendStep).toHaveBeenCalledTimes(2)
    const second = (sendStep.mock.calls[1] as unknown as [UIMessage[]])[0]
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(textOf(second[1])).toBe('answer')
    expect(textOf(second[2])).toContain('mail m2')
    expect(out.stoppedBy).toBe('done')
  })

  it('never drains held mail', async () => {
    useMessageQueue.getState().enqueue('A', envelopeToQueued(envelope('h'), true))
    const sendStep = vi.fn(async () => streamOf(textStep('ok')))
    await runTurn({
      messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'go' }] } as UIMessage],
      signal: new AbortController().signal,
      deps: {
        sendStep,
        dispatch: vi.fn(),
        sink: { onText: vi.fn(), onToolStart: vi.fn(), onToolArgsDelta: vi.fn(), onToolCall: vi.fn() },
        onStep: vi.fn(),
        nextMessageId: () => 'x',
        takeSteering,
      },
    } as never)
    expect(sendStep).toHaveBeenCalledTimes(1)
    expect(useMessageQueue.getState().getQueue('A')).toHaveLength(1)
  })
})
