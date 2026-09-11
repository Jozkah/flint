/**
 * A reply cut off mid-stream is a failed step, not an answer.
 *
 * Found by the AH-109 Windows scenario: a team child whose provider stream
 * dropped after one word ("starting") was recorded as a completed task, and
 * its partial work offered for review as a clean success. The AI SDK still
 * ends such a stream with a `finish` part -- `finishReason: 'other'` and no
 * `rawFinishReason`, measured against the smoke fixture -- so nothing downstream
 * could tell it from a finished reply.
 */
import { describe, it, expect, vi } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'
import { consumeStep, runTurn, type ToolOutcome } from '../coworkRunner'
import { streamCutOff } from '../streamFinish'

const streamOf = (chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> =>
  new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk)
      c.close()
    },
  })

const sink = () => ({
  onText: vi.fn(),
  onToolStart: vi.fn(),
  onToolArgsDelta: vi.fn(),
  onToolCall: vi.fn(),
})

const reply = (text: string, cutOff: boolean): UIMessageChunk[] =>
  [
    { type: 'text-delta', id: 't', delta: text },
    { type: 'finish', messageMetadata: { streamCutOff: cutOff } },
  ] as unknown as UIMessageChunk[]

describe('a finish part', () => {
  it('without the provider’s own reason is a cut-off stream', () => {
    expect(streamCutOff({ type: 'finish', finishReason: 'other' })).toBe(true)
    expect(
      streamCutOff({ type: 'finish', finishReason: 'stop', rawFinishReason: 'stop' })
    ).toBe(false)
    // A provider's own unusual reason is its reason, not a cut-off.
    expect(
      streamCutOff({ type: 'finish', finishReason: 'other', rawFinishReason: 'eos' })
    ).toBe(false)
    expect(streamCutOff({ type: 'finish', finishReason: 'length' })).toBe(false)
  })
})

describe('a step whose stream was cut off', () => {
  it('carries an error, keeping the text that did arrive', async () => {
    const r = await consumeStep(streamOf(reply('starting', true)), sink())
    expect(r.text).toBe('starting')
    expect(r.errorText).toContain('cut off')
    const whole = await consumeStep(streamOf(reply('all done', false)), sink())
    expect(whole.errorText).toBeUndefined()
  })

  it('ends the turn as an error, never as done', async () => {
    const outcome = await runTurn({
      messages: [
        { id: 'u', role: 'user', parts: [{ type: 'text', text: 'go' }] } as UIMessage,
      ],
      signal: new AbortController().signal,
      maxSteps: 4,
      sessionTokens: 0,
      deps: {
        sendStep: vi.fn(async () => streamOf(reply('starting', true))),
        dispatch: vi.fn(async (): Promise<ToolOutcome> => ({ output: 'ok' })),
        sink: sink(),
        onStep: vi.fn(),
        nextMessageId: () => 'm',
      },
    })
    expect(outcome.stoppedBy).toBe('error')
    expect(outcome.errorText).toContain('cut off')
  })
})
