import { describe, expect, it } from 'vitest'
import {
  ImageTap,
  imageOutputMiddleware,
  parseImageDataUrl,
  withImageTap,
} from '../openrouterImages'

const png = 'data:image/png;base64,AAAA'

describe('openrouter image output', () => {
  it('parses image data urls only', () => {
    expect(parseImageDataUrl(png)).toEqual({ mediaType: 'image/png', base64: 'AAAA' })
    expect(parseImageDataUrl('https://x/y.png')).toBeUndefined()
    expect(parseImageDataUrl('data:text/plain;base64,AA')).toBeUndefined()
  })

  it('collects images from a streamed response and emits file parts', async () => {
    const tap = new ImageTap()
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { images: [{ type: 'image_url', image_url: { url: png } }] } }] })}\n\n` +
      'data: [DONE]\n\n'
    const fetchImpl = withImageTap(
      (async () =>
        new Response(sse, {
          headers: { 'content-type': 'text/event-stream' },
        })) as never,
      tap
    )
    const mw = imageOutputMiddleware(tap)
    const parts: unknown[] = []
    const res = await mw.wrapStream!({
      doStream: async () => {
        const r = await fetchImpl('http://x')
        await r.text()
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: 'text-delta', id: '1', delta: 'hi' })
              c.enqueue({ type: 'finish' })
              c.close()
            },
          }),
        }
      },
    } as never)
    const reader = res.stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    expect(parts.map((p) => (p as { type: string }).type)).toEqual([
      'text-delta',
      'file',
      'finish',
    ])
    expect(parts[1]).toMatchObject({ mediaType: 'image/png', data: 'AAAA' })
  })

  it('reads images from a non-streamed JSON response', async () => {
    const tap = new ImageTap()
    const f = withImageTap(
      (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { images: [{ image_url: { url: png } }] } }],
          }),
          { headers: { 'content-type': 'application/json' } }
        )) as never,
      tap
    )
    await f('http://x')
    expect(tap.images).toHaveLength(1)
  })
})
