import { describe, it, expect } from 'vitest'
import { templateParticipants } from '../templateParticipants'

describe('templateParticipants', () => {
  it('seeds one participant per name on the selected model', () => {
    expect(
      templateParticipants(['Pro', 'Con'], { provider: 'llamacpp', id: 'qwen' })
    ).toEqual([
      { name: 'Pro', role: 'Pro', model: { provider: 'llamacpp', id: 'qwen' } },
      { name: 'Con', role: 'Con', model: { provider: 'llamacpp', id: 'qwen' } },
    ])
  })

  it('works for a remote custom provider the same way', () => {
    const out = templateParticipants(['Pro', 'Con'], {
      provider: 'my-custom-provider',
      id: 'gpt-x',
    })
    expect(out).toHaveLength(2)
    expect(out.every((p) => p.model.provider === 'my-custom-provider')).toBe(true)
  })

  it('seeds nothing for a template without sides or with no selected model', () => {
    expect(templateParticipants(undefined, { provider: 'p', id: 'm' })).toEqual([])
    expect(templateParticipants([], { provider: 'p', id: 'm' })).toEqual([])
    expect(templateParticipants(['Pro', 'Con'], null)).toEqual([])
    expect(templateParticipants(['Pro', 'Con'], { provider: '', id: 'm' })).toEqual([])
  })
})
