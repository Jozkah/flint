import { expect, it } from 'vitest'
import { enableModelCapabilities } from '../modelCapabilityEnable'

it('adds selected capabilities without losing existing ones or changing other models', () => {
  const models = [
    { id: 'target', capabilities: ['reasoning', 'audio'] },
    { id: 'other', capabilities: ['vision'] },
  ] as Model[]
  const result = enableModelCapabilities(models, 'target', [
    'tools',
    'audio',
    'video',
  ])
  expect(result[0]).toMatchObject({
    capabilities: ['reasoning', 'audio', 'tools', 'video'],
    _userConfiguredCapabilities: true,
  })
  expect(result[1]).toBe(models[1])
})
