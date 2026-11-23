import { describe, it, expect, vi } from 'vitest'
import {
  CONTINUE_PROMPT,
  buildContinuationMessages,
  continuationJoin,
  continuationStrategy,
  withContinueFinalMessage,
} from '../chat/transport/continuation'
import { prependContinuationToUIStream } from '../chat/transport/messageShaping'

const p = (provider: string, base_url?: string, api_type?: 'anthropic' | 'openai') =>
  ({ provider, base_url, api_type }) as Parameters<typeof continuationStrategy>[0]

describe('continuationStrategy', () => {
  it('keeps the engine prefill for llama.cpp and MLX', () => {
    expect(continuationStrategy(p('llamacpp'))).toBe('prefill')
    expect(continuationStrategy(p('mlx'))).toBe('prefill')
  })
  it('asks OpenAI-compatible servers to continue the final message', () => {
    expect(continuationStrategy(p('my-vllm', 'http://100.1.2.3:8553/v1'))).toBe('prefill-flag')
    expect(continuationStrategy(p('litellm', 'http://x/v1'))).toBe('prefill-flag')
    // An `openai` entry pointed at a gateway is the compatible route.
    expect(continuationStrategy(p('openai', 'https://ai.example.com/v1'))).toBe('prefill-flag')
  })
  it('uses a user turn where the provider cannot prefill', () => {
    expect(continuationStrategy(p('openai', 'https://api.openai.com/v1'))).toBe('user-turn')
    expect(continuationStrategy(p('openai'))).toBe('user-turn')
    expect(continuationStrategy(p('anthropic'))).toBe('user-turn')
    expect(continuationStrategy(p('gemini'))).toBe('user-turn')
    expect(continuationStrategy(p('my-proxy', 'http://x/v1', 'anthropic'))).toBe('user-turn')
  })
})

describe('buildContinuationMessages', () => {
  const base = [{ role: 'user', content: 'hi' }]
  const partial = { role: 'assistant', content: 'half' }
  it('ends on the partial reply for a prefill', () => {
    expect(buildContinuationMessages(base, partial, 'prefill')).toEqual([...base, partial])
    expect(buildContinuationMessages(base, partial, 'prefill-flag')).toEqual([...base, partial])
  })
  it('adds the continue request as a user turn otherwise', () => {
    const out = buildContinuationMessages(base, partial, 'user-turn')
    expect(out).toHaveLength(3)
    expect(out[1]).toBe(partial)
    expect(out[2]).toEqual({ role: 'user', content: [{ type: 'text', text: CONTINUE_PROMPT }] })
  })
})

describe('continuationJoin', () => {
  it('adds a space between a cut-off word and a fresh start', () => {
    expect(continuationJoin('faded as engineers', 'The bicycle')).toBe(' ')
  })
  it('adds nothing when whitespace or closing punctuation is already there', () => {
    expect(continuationJoin('engineers ', 'The')).toBe('')
    expect(continuationJoin('engineers', ' the')).toBe('')
    expect(continuationJoin('engineers', '.')).toBe('')
    expect(continuationJoin('', 'x')).toBe('')
  })
})

describe('withContinueFinalMessage', () => {
  const run = async (messages: unknown[]) => {
    const inner = vi.fn(async () => new Response('{}'))
    await withContinueFinalMessage(inner as never)('http://x/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages }),
    })
    const init = (inner.mock.calls[0] as unknown as [string, { body: string }])[1]
    return JSON.parse(init.body)
  }
  it('asks the server to continue a trailing assistant message', async () => {
    const body = await run([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'half' }])
    expect(body.continue_final_message).toBe(true)
    expect(body.add_generation_prompt).toBe(false)
    expect(body.model).toBe('m')
  })
  it('leaves an ordinary request alone', async () => {
    const body = await run([{ role: 'user', content: 'a' }])
    expect(body.continue_final_message).toBeUndefined()
    expect(body.add_generation_prompt).toBeUndefined()
  })
})

describe('prependContinuationToUIStream', () => {
  const source = (deltas: string[]) =>
    new ReadableStream({
      start(c) {
        c.enqueue({ type: 'text-start', id: 't' })
        for (const delta of deltas) c.enqueue({ type: 'text-delta', id: 't', delta })
        c.close()
      },
    })
  const collect = async (s: ReadableStream) => {
    const r = s.getReader()
    let text = ''
    for (;;) {
      const { done, value } = await r.read()
      if (done) return text
      if ((value as { type: string }).type === 'text-delta') text += (value as { delta: string }).delta
    }
  }
  it('spaces the pieces when the resume started a new turn', async () => {
    const out = prependContinuationToUIStream(
      source(['The bicycle', ' is']) as never,
      { text: 'faded as engineers' },
      { joinFirstDelta: true }
    )
    expect(await collect(out)).toBe('faded as engineers The bicycle is')
  })
  it('joins nothing for a prefill that continues mid-word', async () => {
    const out = prependContinuationToUIStream(source(['ing past']) as never, { text: 'engineer' })
    expect(await collect(out)).toBe('engineering past')
  })
})
