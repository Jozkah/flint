import { describe, expect, it } from 'vitest'
import { groupDevices, groupForGpu, parseDeviceId, selectedDevice } from '../gpuDevices'

const device = (id: string, name: string, activated = false) => ({
  id,
  name,
  mem: 16000,
  free: 12000,
  activated,
})

const gpu = (uuid: string, extra: Record<string, unknown> = {}) =>
  ({ uuid, name: 'RTX', vendor: 'NVIDIA', total_memory: 16000, driver_version: '1', ...extra }) as never

describe('gpuDevices', () => {
  it('reads the backend and index out of a device id', () => {
    expect(parseDeviceId('CUDA0')).toEqual({ backend: 'CUDA', index: 0 })
    expect(parseDeviceId('Vulkan12')).toEqual({ backend: 'Vulkan', index: 12 })
    expect(parseDeviceId('weird')).toEqual({ backend: 'weird', index: 0 })
  })

  it('joins the CUDA and Vulkan entries of one card into a group, preferred backend first', () => {
    const groups = groupDevices([device('Vulkan0', 'RTX'), device('CUDA0', 'RTX')])
    expect(groups).toHaveLength(1)
    expect(groups[0].devices.map((d) => d.id)).toEqual(['CUDA0', 'Vulkan0'])
    expect(selectedDevice(groups[0]).id).toBe('CUDA0')
  })

  it('keeps two cards of the same name apart', () => {
    expect(groupDevices([device('CUDA0', 'RTX'), device('CUDA1', 'RTX')])).toHaveLength(2)
  })

  it('prefers the device that is switched on', () => {
    const [group] = groupDevices([device('CUDA0', 'RTX'), device('Vulkan0', 'RTX', true)])
    expect(selectedDevice(group).id).toBe('Vulkan0')
  })

  it('finds the group of a hardware-plugin GPU through either backend index', () => {
    const groups = groupDevices([device('CUDA0', 'RTX'), device('Vulkan0', 'RTX')])
    const card = gpu('a', { nvidia_info: { index: 0, compute_capability: '8.9' } })
    const other = gpu('b', { nvidia_info: { index: 3, compute_capability: '8.9' } })
    expect(groupForGpu(groups, card, [card, other])).toBe(groups[0])
    expect(groupForGpu(groups, other, [card, other])).toBeUndefined()
  })
})
