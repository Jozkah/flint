import { describe, it, expect, vi } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'

const invoke = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { runTurn } from '../coworkRunner'

const streamOf = (chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> =>
  new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk)
      c.close()
    },
  })

/** A step whose only call names a tool this agent was never offered. */
const invalidStep = (): UIMessageChunk[] => [
  { type: 'start-step' } as UIMessageChunk,
  { type: 'tool-input-start', toolCallId: 'call_0', toolName: 'write' } as UIMessageChunk,
  {
    type: 'tool-input-error',
    toolCallId: 'call_0',
    toolName: 'write',
    input: { path: 'x' },
    errorText: "Model tried to call unavailable tool 'write'.",
  } as unknown as UIMessageChunk,
  { type: 'finish-step' } as UIMessageChunk,
  { type: 'finish', finishReason: 'tool-calls' } as unknown as UIMessageChunk,
]

const textStep = (): UIMessageChunk[] => [
  { type: 'start-step' } as UIMessageChunk,
  { type: 'text-start', id: 't' } as UIMessageChunk,
  { type: 'text-delta', id: 't', delta: 'done' } as UIMessageChunk,
  { type: 'text-end', id: 't' } as UIMessageChunk,
  { type: 'finish-step' } as UIMessageChunk,
  { type: 'finish', finishReason: 'stop' } as unknown as UIMessageChunk,
]

describe('a call the runner refuses without dispatching', () => {
  // Found by the integration scenario matrix: a child's refused calls were
  // recorded with no session, so they fell out of the run's record and two
  // children's call_0 merged into one item.
  it('is recorded under the run that asked for it', async () => {
    const steps = [invalidStep(), textStep()]
    let i = 0
    await runTurn({
      messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as UIMessage],
      signal: new AbortController().signal,
      deps: {
        sendStep: vi.fn(async () => streamOf(steps[Math.min(i++, steps.length - 1)])),
        dispatch: vi.fn(async () => ({ output: 'ok' })),
        sink: { onText: vi.fn(), onToolStart: vi.fn(), onToolArgsDelta: vi.fn(), onToolCall: vi.fn() },
        onStep: vi.fn(),
        nextMessageId: () => 'm',
        activity: () => ({ session: 's1', run: 'r1', agent: 'reviewer', invocation: 'inv-1' }),
      },
    })
    await vi.waitFor(() =>
      expect(invoke.mock.calls.filter(([cmd]) => cmd === 'tool_activity_record')).toHaveLength(2)
    )
    const events = invoke.mock.calls
      .filter(([cmd]) => cmd === 'tool_activity_record')
      .map(([, args]) => (args as { event: Record<string, unknown> }).event)
    expect(events.map((e) => e.phase)).toEqual(['requested', 'refused'])
    for (const e of events) {
      expect(e).toMatchObject({ session: 's1', run: 'r1', agent: 'reviewer', invocation: 'inv-1', call: 'call_0' })
    }
  })
})
