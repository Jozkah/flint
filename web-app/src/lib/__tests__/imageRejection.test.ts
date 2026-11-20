import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCustomFetch } from '@/lib/model/customFetch'
import {
  IMAGE_REJECTED_STAND_IN,
  isImageInputRejection,
  stripImagePartsInBody,
} from '@/lib/model/imageRejection'

const mockToastWarning = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { warning: mockToastWarning } }))

const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('isImageInputRejection', () => {
  it.each([
    'No endpoints found that support image input',
    'image input is not supported - hint: if this is unexpected, you may need to provide the mmproj',
    'Invalid content type. image_url is only supported by certain models.',
    'Failed to deserialize the JSON body into the target type: messages[3]: unknown variant `image_url`, expected `text`',
    'This model does not support image inputs.',
    'Vision is not supported for this model',
  ])('matches %j', (message) => {
    expect(isImageInputRejection(message)).toBe(true)
  })

  it.each([
    'Unsupported parameter: top_k',
    "This model's maximum context length is 8192 tokens",
    'All providers have been ignored.',
  ])('does not match %j', (message) => {
    expect(isImageInputRejection(message)).toBe(false)
  })
})

describe('stripImagePartsInBody', () => {
  it('replaces user images and flattens an all-text tool message', () => {
    const body: Record<string, unknown> = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: PNG } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [
            { type: 'text', text: 'The tool returned 1 image.' },
            { type: 'image_url', image_url: { url: PNG, detail: 'auto' } },
          ],
        },
      ],
    }
    expect(stripImagePartsInBody(body)).toBe(2)
    const [user, tool] = body.messages as Array<{ content: unknown }>
    expect(user.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'text', text: IMAGE_REJECTED_STAND_IN },
    ])
    expect(tool.content).toBe(`The tool returned 1 image. ${IMAGE_REJECTED_STAND_IN}`)
    expect(JSON.stringify(body)).not.toContain('base64')
  })

  it('handles Anthropic, Responses and Gemini image parts', () => {
    const body: Record<string, unknown> = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [
                { type: 'text', text: 'ok' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
              ],
            },
          ],
        },
      ],
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: PNG }] }],
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }] }],
    }
    expect(stripImagePartsInBody(body)).toBe(3)
    const json = JSON.stringify(body)
    expect(json).not.toContain('AAAA')
    expect(json).not.toContain('input_image')
  })

  it('leaves a body without images alone', () => {
    const body: Record<string, unknown> = {
      messages: [{ role: 'tool', content: [{ type: 'text', text: 'a' }] }],
    }
    expect(stripImagePartsInBody(body)).toBe(0)
    expect((body.messages as any)[0].content).toEqual([{ type: 'text', text: 'a' }])
  })
})

describe('createCustomFetch image input rejection', () => {
  const REJECTION = JSON.stringify({
    error: { message: 'No endpoints found that support image input', code: 404 },
  })
  const URL = 'https://openrouter.ai/api/v1/chat/completions'

  const json = (status: number, body: string) =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } })

  const withImage = (): RequestInit => ({
    method: 'POST',
    body: JSON.stringify({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: PNG } },
          ],
        },
      ],
    }),
  })

  beforeEach(() => mockToastWarning.mockClear())

  it('retries once without images and returns the retry', async () => {
    const sent: Array<Record<string, any>> = []
    const baseFetch = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(init!.body as string))
      return sent.length === 1 ? json(404, REJECTION) : json(200, '{"ok":true}')
    }) as unknown as typeof globalThis.fetch

    const res = await createCustomFetch(baseFetch, {})(URL, withImage())

    expect(res.status).toBe(200)
    expect(baseFetch).toHaveBeenCalledTimes(2)
    expect(sent[0].messages[0].content[1].type).toBe('image_url')
    expect(sent[1].messages[0].content[1]).toEqual({
      type: 'text',
      text: IMAGE_REJECTED_STAND_IN,
    })
    await vi.waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1))
  })

  it('does not retry when the request carried no images', async () => {
    const baseFetch = vi.fn(async () => json(404, REJECTION)) as unknown as typeof globalThis.fetch
    const res = await createCustomFetch(baseFetch, {})(URL, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(404)
    expect(baseFetch).toHaveBeenCalledTimes(1)
  })

  it('surfaces the original error when the retry also fails', async () => {
    let calls = 0
    const baseFetch = vi.fn(async () => {
      calls++
      return calls === 1
        ? json(404, REJECTION)
        : json(400, JSON.stringify({ error: { message: 'something else' } }))
    }) as unknown as typeof globalThis.fetch
    const res = await createCustomFetch(baseFetch, {})(URL, withImage())
    expect(baseFetch).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(404)
    expect((await res.json()).error.message).toBe(
      'No endpoints found that support image input'
    )
    expect(mockToastWarning).not.toHaveBeenCalled()
  })
})
