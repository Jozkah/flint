import { describe, expect, it } from 'vitest'
import { modelKey, unavailableModels } from '../modelReplace'

const providers: Record<string, unknown> = {
  remote: { provider: 'remote', active: true, api_key: 'k', base_url: 'http://x/v1', models: [{ id: 'live' }] },
}
const lookup = (name: string) => providers[name] as never

describe('unavailableModels', () => {
  it('lists a model its provider no longer has, a missing provider, and each once', () => {
    const out = unavailableModels(
      [
        { provider: 'remote', id: 'live' },
        { provider: 'remote', id: 'gone' },
        { provider: 'remote', id: 'gone' },
        { provider: 'nowhere', id: 'x' },
        null,
        undefined,
      ],
      lookup
    )
    expect(out.map(modelKey)).toEqual([
      modelKey({ provider: 'remote', id: 'gone' }),
      modelKey({ provider: 'nowhere', id: 'x' }),
    ])
  })

  it('is empty when everything resolves', () => {
    expect(unavailableModels([{ provider: 'remote', id: 'live' }], lookup)).toEqual([])
  })
})
