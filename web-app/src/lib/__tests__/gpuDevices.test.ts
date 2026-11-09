import { describe, expect, it } from 'vitest'
import type { GPU } from '@/hooks/useHardware'
import {
  findGpuForDevice,
  groupDevices,
  groupForGpu,
  parseDeviceId,
  selectedDevice,
} from '../gpuDevices'

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

const vkGpu = (name: string, vulkanIndex: number | null, cudaIndex?: number) =>
  ({
    name,
    uuid: name,
    driver_version: name,
    nvidia_info:
      cudaIndex === undefined
        ? null
        : { index: cudaIndex, compute_capability: '8.9' },
    vulkan_info:
      vulkanIndex === null
        ? null
        : {
            index: vulkanIndex,
            device_id: 0,
            device_type: '',
            api_version: '1',
          },
  }) as unknown as GPU

const nvidia = vkGpu('RTX 4060 Ti', 0, 0)
const intel = vkGpu('Intel UHD 770', 1)

describe('findGpuForDevice', () => {
  it('joins a Vulkan device by name when llama.cpp reorders devices', () => {
    // GGML_VK_VISIBLE_DEVICES=1,0 makes Intel Vulkan0.
    const found = findGpuForDevice(
      { id: 'Vulkan0', name: 'Intel UHD 770' },
      [nvidia, intel]
    )
    expect(found).toBe(intel)
  })

  it('pairs identical twin cards by rank, not raw index', () => {
    // iGPU at raw index 0, twin dGPUs at 1 and 2; llama.cpp keeps only the twins.
    const a = vkGpu('Twin', 1)
    const b = vkGpu('Twin', 2)
    const devices = [
      { id: 'Vulkan0', name: 'Twin' },
      { id: 'Vulkan1', name: 'Twin' },
    ]
    expect(findGpuForDevice(devices[0], [intel, b, a], devices)).toBe(a)
    expect(findGpuForDevice(devices[1], [intel, b, a], devices)).toBe(b)
  })

  it('pairs the one leftover device and GPU when an NVML name differs', () => {
    const devices = [
      { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 4060 Ti' },
      { id: 'Vulkan1', name: 'Intel UHD 770' },
    ]
    expect(findGpuForDevice(devices[0], [intel, nvidia], devices)).toBe(nvidia)
    expect(findGpuForDevice(devices[1], [intel, nvidia], devices)).toBe(intel)
  })

  it('does not guess when several devices are unmatched', () => {
    const devices = [
      { id: 'Vulkan0', name: 'A' },
      { id: 'Vulkan1', name: 'B' },
    ]
    expect(
      findGpuForDevice(devices[0], [nvidia, vkGpu('Other', 1)], devices)
    ).toBeUndefined()
  })

  it('returns nothing when the name matches no GPU', () => {
    expect(
      findGpuForDevice({ id: 'Vulkan0', name: 'Mystery' }, [nvidia, intel])
    ).toBeUndefined()
  })

  it('keeps CUDA joined by index', () => {
    expect(
      findGpuForDevice({ id: 'CUDA0', name: 'RTX 4060 Ti' }, [intel, nvidia])
    ).toBe(nvidia)
  })

  it('returns nothing for other backends', () => {
    expect(findGpuForDevice({ id: 'Metal0', name: 'x' }, [nvidia])).toBeUndefined()
  })

  // Hybrid laptop: llama.cpp lists the iGPU first, the plugin the dGPU. The
  // System Monitor switch of each card must drive that card's own device.
  it('gives each GPU its own group when Vulkan numbering differs', () => {
    const groups = groupDevices([
      device('Vulkan0', 'Intel UHD 770'),
      device('Vulkan1', 'RTX 4060 Ti'),
    ])
    expect(groupForGpu(groups, nvidia, [nvidia, intel])?.name).toBe('RTX 4060 Ti')
    expect(groupForGpu(groups, intel, [nvidia, intel])?.name).toBe('Intel UHD 770')
  })
})
