import { describe, it, expect } from 'vitest'
import type { ModelMessage } from 'ai'
import {
  CLEARED_TOOL_OUTPUT,
  estimateModelMessages,
  estimateToolTokens,
  guardStepMessages,
} from '../stepContext'

const call = (id: string): ModelMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: id, toolName: 'read', input: { path: `/w/${id}` } }],
  }) as ModelMessage

const result = (id: string, chars: number): ModelMessage =>
  ({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'read',
        output: { type: 'text', value: `${id}:`.padEnd(chars, 'x') },
      },
    ],
  }) as ModelMessage

const loop = (...sizes: number[]): ModelMessage[] => [
  { role: 'user', content: 'start' },
  ...sizes.flatMap((n, i) => [call(`c${i}`), result(`c${i}`, n)]),
]

const textOf = (m: ModelMessage) =>
  JSON.stringify((m as { content: unknown }).content)

describe('guardStepMessages', () => {
  const base = { system: 'sys', toolTokens: 200, window: 8000, maxOutputTokens: 500 }

  it('leaves a request that fits untouched', () => {
    const messages = loop(2000, 2000)
    const out = guardStepMessages({ ...base, messages })
    expect(out.messages).toBe(messages)
    expect(out).toMatchObject({ cleared: 0, clipped: 0, finish: false })
  })

  it('clears the oldest tool output first and keeps the newest', () => {
    // About 3 x 5,000 tokens against an 8,000 window.
    const messages = loop(17_500, 17_500, 17_500)
    const out = guardStepMessages({ ...base, messages })
    expect(out.cleared).toBeGreaterThan(0)
    expect(textOf(out.messages[2])).toContain(CLEARED_TOOL_OUTPUT.slice(0, 20))
    // The newest results are the last to go.
    expect(textOf(out.messages[6])).not.toContain(CLEARED_TOOL_OUTPUT.slice(0, 20))
    // A tool call is never parted from its result: the message count is unchanged.
    expect(out.messages).toHaveLength(messages.length)
  })

  it('cuts the newest result to fit when it alone is too large, and keeps tools on if there is room', () => {
    const messages = loop(1000, 60_000)
    const out = guardStepMessages({ ...base, messages })
    expect(out.clipped).toBe(1)
    expect(estimateModelMessages(out.messages)).toBeLessThan(8000)
    expect(textOf(out.messages[4])).toContain('cut to fit')
  })

  it('ends the tool loop when even the trimmed request leaves no room for the next result', () => {
    // Tool definitions alone take most of the window.
    const out = guardStepMessages({ ...base, toolTokens: 6200, messages: loop(20_000, 20_000) })
    expect(out.finish).toBe(true)
  })

  it('treats the provider count of the last request as a floor', () => {
    const messages = loop(1000)
    const fits = guardStepMessages({ ...base, messages })
    expect(fits.finish).toBe(false)
    const under = guardStepMessages({ ...base, messages, lastRequestTokens: 9000 })
    expect(under.finish || under.cleared + under.clipped > 0).toBe(true)
  })

  it('never touches non-tool messages', () => {
    const messages = loop(17_500, 17_500, 17_500)
    const out = guardStepMessages({ ...base, messages })
    expect(out.messages[0]).toBe(messages[0])
    expect(out.messages[1]).toBe(messages[1])
  })
})

describe('estimateToolTokens', () => {
  it('counts names, descriptions and schemas', () => {
    const small = estimateToolTokens({ a: { description: 'x', inputSchema: {} } })
    const big = estimateToolTokens({
      a: { description: 'x'.repeat(3500), inputSchema: { jsonSchema: { properties: { p: 'y'.repeat(3500) } } } },
    })
    expect(big).toBeGreaterThan(small + 1500)
    expect(estimateToolTokens(undefined)).toBe(0)
  })
})
