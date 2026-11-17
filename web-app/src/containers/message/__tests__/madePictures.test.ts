import { describe, it, expect } from 'vitest'
import { madePictures, isMadePictureTool } from '../madePictures'
import type { MessagePartLike } from '../types'

const img = (name: string) => ({ dataUrl: `data:image/png;base64,${name}`, name })
const tool = (name: string, state: MessagePartLike['state'], toolImages?: MessagePartLike['toolImages']): MessagePartLike => ({
  type: `tool-${name}`,
  state,
  toolImages,
})

describe('madePictures', () => {
  it('collects the pictures image_gen and image_edit made, in order', () => {
    const parts = [
      tool('image_gen', 'output-available', [img('a')]),
      tool('bash', 'output-available', [img('skip')]),
      tool('image_edit', 'output-available', [img('b'), img('c')]),
    ]
    expect(madePictures(parts).map((i) => i.name)).toEqual(['a', 'b', 'c'])
  })

  it('shows nothing for a call that is running or failed', () => {
    expect(madePictures([tool('image_gen', 'input-available', [img('a')])])).toEqual([])
    expect(madePictures([tool('image_gen', 'output-error', [img('a')])])).toEqual([])
  })

  it('does not take image_view, whose picture is for the model', () => {
    expect(isMadePictureTool('image_view')).toBe(false)
    expect(madePictures([tool('image_view', 'output-available', [img('a')])])).toEqual([])
  })
})
