import { describe, expect, it, vi } from 'vitest'
import { fitImageFileToLimit, type EncodeImage } from '@/lib/imageResize'

const MB = 1024 * 1024

const file = (name: string, type: string, size: number) =>
  new File([new Uint8Array(size)], name, { type })

const blobOf = (size: number, type = 'image/webp') =>
  new Blob([new Uint8Array(size)], { type })

describe('fitImageFileToLimit', () => {
  it('leaves a file already within the limit alone', async () => {
    const small = file('a.png', 'image/png', 1 * MB)
    const encode = vi.fn<EncodeImage>()
    expect(await fitImageFileToLimit(small, 10 * MB, encode)).toBe(small)
    expect(encode).not.toHaveBeenCalled()
  })

  it('leaves a non-image and a GIF alone', async () => {
    const encode = vi.fn<EncodeImage>()
    const pdf = file('a.pdf', 'application/pdf', 20 * MB)
    const gif = file('a.gif', 'image/gif', 20 * MB)
    expect(await fitImageFileToLimit(pdf, 10 * MB, encode)).toBe(pdf)
    expect(await fitImageFileToLimit(gif, 10 * MB, encode)).toBe(gif)
    expect(encode).not.toHaveBeenCalled()
  })

  it('re-encodes an oversized image under the limit, trying smaller sizes in turn', async () => {
    const big = file('screen.png', 'image/png', 15 * MB)
    const encode = vi
      .fn<EncodeImage>()
      .mockResolvedValueOnce(blobOf(12 * MB))
      .mockResolvedValueOnce(blobOf(11 * MB))
      .mockResolvedValueOnce(blobOf(6 * MB))
    const out = await fitImageFileToLimit(big, 10 * MB, encode)
    expect(out).not.toBe(big)
    expect(out.name).toBe('screen.webp')
    expect(out.type).toBe('image/webp')
    expect(out.size).toBe(6 * MB)
    expect(encode).toHaveBeenCalledTimes(3)
    expect(encode.mock.calls[0][1]).toBeGreaterThan(encode.mock.calls[2][1])
  })

  it('names a JPEG fallback .jpg', async () => {
    const big = file('photo.final.png', 'image/png', 15 * MB)
    const encode = vi.fn<EncodeImage>().mockResolvedValue(blobOf(2 * MB, 'image/jpeg'))
    expect((await fitImageFileToLimit(big, 10 * MB, encode)).name).toBe('photo.final.jpg')
  })

  it('returns the original when nothing fits, or when decoding throws', async () => {
    const big = file('a.png', 'image/png', 15 * MB)
    expect(
      await fitImageFileToLimit(big, 10 * MB, async () => blobOf(20 * MB))
    ).toBe(big)
    expect(
      await fitImageFileToLimit(big, 10 * MB, async () => {
        throw new Error('cannot decode')
      })
    ).toBe(big)
    expect(await fitImageFileToLimit(big, 10 * MB, async () => null)).toBe(big)
  })
})
