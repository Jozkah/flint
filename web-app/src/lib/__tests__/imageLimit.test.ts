import { describe, expect, it, beforeEach } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import type { UIMessageChunk } from 'ai'
import {
  forgetImageLimits,
  imageLimitFor,
  imageLimitKey,
  limitImageParts,
  parseImageLimit,
  rememberImageLimit,
} from '../imageLimit'
import { withEarlyRetry } from '../earlyRetryStream'

describe('parseImageLimit', () => {
  it('reads the vLLM refusal from a message, a string or error data', () => {
    const text = 'At most 0 image(s) may be provided in one prompt.'
    expect(parseImageLimit(text)).toBe(0)
    expect(parseImageLimit(new Error(text))).toBe(0)
    expect(
      parseImageLimit({ message: 'Bad Request', data: { error: { message: text } } })
    ).toBe(0)
    expect(parseImageLimit('At most 4 images may be provided')).toBe(4)
  })

  it('ignores other failures', () => {
    expect(parseImageLimit(new Error('context length exceeded'))).toBeNull()
    expect(parseImageLimit(null)).toBeNull()
  })
})

describe('learned limits', () => {
  beforeEach(forgetImageLimits)
  it('are kept per model', () => {
    const key = imageLimitKey('openai', 'qwen-vl')
    expect(imageLimitFor(key)).toBeUndefined()
    rememberImageLimit(key, 0)
    expect(imageLimitFor(key)).toBe(0)
    expect(imageLimitFor(imageLimitKey('openai', 'other'))).toBeUndefined()
  })
})

const msg = (id: string, ...parts: unknown[]) =>
  ({ id, role: 'user', parts }) as unknown as UIMessage
const image = (n: number) => ({
  type: 'file',
  mediaType: 'image/png',
  url: `data:image/png;base64,${n}`,
})
const text = (t: string) => ({ type: 'text', text: t })

describe('limitImageParts', () => {
  it('keeps only the newest images and all text', () => {
    const out = limitImageParts(
      [msg('a', text('one'), image(1)), msg('b', image(2), text('two'), image(3))],
      2
    )
    expect(out[0].parts).toEqual([text('one')])
    expect(out[1].parts).toEqual([image(2), text('two'), image(3)])
  })

  it('drops every image at a limit of 0', () => {
    const out = limitImageParts([msg('a', image(1), text('x'))], 0)
    expect(out[0].parts).toEqual([text('x')])
  })

  it('leaves messages without images untouched', () => {
    const m = msg('a', text('x'))
    expect(limitImageParts([m], 1)[0]).toBe(m)
  })
})

const streamOf = (chunks: unknown[]) =>
  new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c as UIMessageChunk)
      controller.close()
    },
  })

const drain = async (stream: ReadableStream<UIMessageChunk>) => {
  const out: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

describe('withEarlyRetry', () => {
  it('swallows an early refusal and continues on the resent stream', async () => {
    const first = streamOf([
      { type: 'start' },
      { type: 'start-step' },
      { type: 'error', errorText: 'At most 0 image(s) may be provided' },
    ])
    let resent = 0
    const out = await drain(
      withEarlyRetry(
        first,
        (t) => parseImageLimit(t) === 0,
        async () => {
          resent += 1
          return streamOf([
            { type: 'start' },
            { type: 'start-step' },
            { type: 'text-delta', id: 't', delta: 'hi' },
            { type: 'finish' },
          ])
        }
      )
    )
    expect(resent).toBe(1)
    expect(out.map((c) => c.type)).toEqual([
      'start',
      'start-step',
      'text-delta',
      'finish',
    ])
  })

  it('does not retry once reply content has started', async () => {
    const first = streamOf([
      { type: 'start' },
      { type: 'text-delta', id: 't', delta: 'x' },
      { type: 'error', errorText: 'At most 0 image(s) may be provided' },
    ])
    const out = await drain(
      withEarlyRetry(first, () => true, async () => streamOf([]))
    )
    expect(out.map((c) => c.type)).toEqual(['start', 'text-delta', 'error'])
  })
})
