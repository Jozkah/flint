import { describe, expect, it } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import { prepareToolResultImagesForModel } from '@/lib/toolResultImages'

const BIG = 'A'.repeat(50_000)

const toolMessage = (output: unknown): UIMessage =>
  ({
    id: 'm1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-get_screenshot',
        toolCallId: 'c1',
        state: 'output-available',
        input: {},
        output,
      },
    ],
  }) as unknown as UIMessage

describe('prepareToolResultImagesForModel', () => {
  it('replaces the image with a note and drops the base64 for a text-only model', () => {
    const [out, ...rest] = prepareToolResultImagesForModel(
      [toolMessage([{ type: 'image', data: BIG, mimeType: 'image/png' }])],
      { supportsVision: false }
    )
    expect(rest).toHaveLength(0)
    expect(JSON.stringify(out)).not.toContain(BIG)
    expect(JSON.stringify(out)).toContain('left out to save context')
  })

  it('re-attaches the image as a user file part for a vision model', () => {
    const out = prepareToolResultImagesForModel(
      [toolMessage([{ type: 'image', data: BIG, mimeType: 'image/jpeg' }])],
      { supportsVision: true }
    )
    expect(out).toHaveLength(2)
    expect(JSON.stringify(out[0])).not.toContain(BIG)
    expect(out[1].role).toBe('user')
    expect(out[1].parts[1]).toMatchObject({
      type: 'file',
      mediaType: 'image/jpeg',
      url: `data:image/jpeg;base64,${BIG}`,
    })
  })

  it('reads a data URL and the image.url form', () => {
    const out = prepareToolResultImagesForModel(
      [
        toolMessage([
          { type: 'image', image: { url: `data:image/png;base64,${BIG}` } },
        ]),
      ],
      { supportsVision: true }
    )
    expect(out[1].parts[1]).toMatchObject({
      url: `data:image/png;base64,${BIG}`,
    })
  })

  it('returns messages without tool images by reference', () => {
    const plain = toolMessage([{ type: 'text', text: 'ok' }])
    const user = {
      id: 'u',
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
    } as UIMessage
    const out = prepareToolResultImagesForModel([user, plain], {
      supportsVision: false,
    })
    expect(out[0]).toBe(user)
    expect(out[1]).toBe(plain)
  })

  it('ignores a string output and an image block with no data', () => {
    const a = toolMessage('plain string')
    const b = toolMessage([{ type: 'image', data: '' }])
    expect(
      prepareToolResultImagesForModel([a, b], { supportsVision: true })
    ).toEqual([a, b])
  })
})
