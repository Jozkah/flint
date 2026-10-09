import { describe, expect, it } from 'vitest'
import { extractModelSamplingDefaults } from '../custom-chat-transport'

const model = (stop: unknown) =>
  ({
    id: 'm',
    settings: { stop_strings: { controller_props: { value: stop } } },
  }) as unknown as Model

describe('per-model stop strings', () => {
  it('forwards the text as the request `stop`', () => {
    expect(extractModelSamplingDefaults(model('<|im_end|>\n</s>')).stop).toBe(
      '<|im_end|>\n</s>'
    )
  })

  it('omits stop when blank', () => {
    expect(extractModelSamplingDefaults(model('  \n')).stop).toBeUndefined()
    expect(extractModelSamplingDefaults(model('')).stop).toBeUndefined()
  })
})
