import { describe, expect, it } from 'vitest'
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider'
import { textToolCallMiddleware } from '@/lib/textToolCallMiddleware'

const tools = [
  {
    type: 'function' as const,
    name: 'read_file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
]

const params = (withTools = true) =>
  ({ prompt: [], tools: withTools ? tools : undefined }) as unknown as LanguageModelV3CallOptions

const stop = { unified: 'stop' as const, raw: 'stop' }
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function streamOf(deltas: string[], extra: LanguageModelV3StreamPart[] = []) {
  const parts: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    ...deltas.map(
      (delta): LanguageModelV3StreamPart => ({ type: 'text-delta', id: 't', delta })
    ),
    { type: 'text-end', id: 't' },
    ...extra,
    { type: 'finish', usage, finishReason: stop } as LanguageModelV3StreamPart,
  ]
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

async function run(
  deltas: string[],
  opts: { withTools?: boolean; extra?: LanguageModelV3StreamPart[] } = {}
) {
  const mw = textToolCallMiddleware()
  const result = await mw.wrapStream!({
    doGenerate: async () => {
      throw new Error('unused')
    },
    doStream: async () => ({ stream: streamOf(deltas, opts.extra) }),
    params: params(opts.withTools ?? true),
    model: {} as never,
  })
  const parts: LanguageModelV3StreamPart[] = []
  const reader = result.stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

const textOf = (parts: LanguageModelV3StreamPart[]) =>
  parts.map((p) => (p.type === 'text-delta' ? p.delta : '')).join('')

describe('textToolCallMiddleware stream', () => {
  it('converts a Hermes call split across deltas and flips the finish reason', async () => {
    const parts = await run([
      'Let me look. <tool',
      '_call>{"name":"read_file",',
      '"arguments":{"path":"a.txt"}}</tool_',
      'call>',
    ])
    expect(textOf(parts)).toBe('Let me look. ')
    const call = parts.find((p) => p.type === 'tool-call')
    expect(call).toMatchObject({ toolName: 'read_file', input: '{"path":"a.txt"}' })
    const finish = parts.find((p) => p.type === 'finish') as { finishReason: { unified: string } }
    expect(finish.finishReason.unified).toBe('tool-calls')
  })

  it('passes ordinary text, including a lone "<", through untouched', async () => {
    const parts = await run(['a < b and ', '<b>bold</b>'])
    expect(textOf(parts)).toBe('a < b and <b>bold</b>')
    expect(parts.some((p) => p.type === 'tool-call')).toBe(false)
  })

  it('restores text that looked like a call but names an unknown tool', async () => {
    const text = '<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>'
    const parts = await run([text])
    expect(textOf(parts)).toBe(text)
    expect(parts.some((p) => p.type === 'tool-call')).toBe(false)
  })

  it('restores an unparseable block as text', async () => {
    const text = '<tool_call>{"name":'
    expect(textOf(await run([text]))).toBe(text)
  })

  it('does nothing when the request has no tools', async () => {
    const text = '<tool_call>{"name":"read_file","arguments":{}}</tool_call>'
    const parts = await run([text], { withTools: false })
    expect(textOf(parts)).toBe(text)
  })

  it('stands down when the server already sent a structured tool call', async () => {
    const text = '<tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call>'
    const parts = await run([text], {
      extra: [
        { type: 'tool-call', toolCallId: 'native', toolName: 'read_file', input: '{}' },
      ],
    })
    expect(parts.filter((p) => p.type === 'tool-call')).toHaveLength(1)
  })
})

describe('textToolCallMiddleware generate', () => {
  it('replaces a text call with a tool-call part', async () => {
    const mw = textToolCallMiddleware()
    const result = await mw.wrapGenerate!({
      doGenerate: async () =>
        ({
          content: [
            {
              type: 'text',
              text: '[TOOL_CALLS][{"name":"read_file","arguments":{"path":"b"}}]',
            },
          ],
          finishReason: stop,
          usage,
          warnings: [],
        }) as never,
      doStream: async () => {
        throw new Error('unused')
      },
      params: params(),
      model: {} as never,
    })
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toMatchObject({
      type: 'tool-call',
      toolName: 'read_file',
      input: '{"path":"b"}',
    })
    expect(result.finishReason.unified).toBe('tool-calls')
  })
})
