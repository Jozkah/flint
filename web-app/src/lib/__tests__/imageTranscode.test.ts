import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import { transcodeWebpImages } from '@/lib/imageTranscode'

const message = (parts: unknown[]): UIMessage =>
  ({ id: 'm', role: 'user', parts }) as unknown as UIMessage

const webp = {
  type: 'file',
  mediaType: 'image/webp',
  url: 'data:image/webp;base64,AAAA',
}

describe('transcodeWebpImages', () => {
  it('replaces a WebP file part with a PNG one', async () => {
    const transcode = vi.fn().mockResolvedValue('data:image/png;base64,BBBB')
    const [out] = await transcodeWebpImages(
      [message([{ type: 'text', text: 'look' }, webp])],
      transcode
    )
    expect(transcode).toHaveBeenCalledWith('data:image/webp;base64,AAAA')
    expect(out.parts[1]).toMatchObject({
      type: 'file',
      mediaType: 'image/png',
      url: 'data:image/png;base64,BBBB',
    })
    expect(out.parts[0]).toEqual({ type: 'text', text: 'look' })
  })

  it('recognises WebP by its data URL when the media type is missing', async () => {
    const transcode = vi.fn().mockResolvedValue('data:image/png;base64,CC')
    const [out] = await transcodeWebpImages(
      [message([{ type: 'file', url: 'data:image/webp;base64,AA' }])],
      transcode
    )
    expect(out.parts[0]).toMatchObject({ mediaType: 'image/png' })
  })

  it('leaves other images and messages alone, by reference', async () => {
    const transcode = vi.fn()
    const png = message([
      { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AA' },
    ])
    const text = message([{ type: 'text', text: 'hi' }])
    const out = await transcodeWebpImages([png, text], transcode)
    expect(out[0]).toBe(png)
    expect(out[1]).toBe(text)
    expect(transcode).not.toHaveBeenCalled()
  })

  it('keeps the original part when transcoding fails or is unavailable', async () => {
    const failing = await transcodeWebpImages(
      [message([webp])],
      async () => {
        throw new Error('decode failed')
      }
    )
    expect(failing[0].parts[0]).toEqual(webp)
    const unavailable = await transcodeWebpImages([message([webp])], async () => null)
    expect(unavailable[0].parts[0]).toEqual(webp)
  })
})
