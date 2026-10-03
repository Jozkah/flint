import type { GPU } from '@/hooks/useHardware'
import type { DeviceList } from '@/services/hardware/types'

/**
 * llama.cpp lists one device per backend, so one physical GPU can appear as
 * both CUDA0 and Vulkan0. These helpers group those into one entry per GPU and
 * join them to the hardware plugin's GPU list, for the System Monitor's
 * "use this GPU for models" switch.
 */

export const BACKEND_LABELS: Record<string, string> = {
  vulkan: 'Vulkan',
  cuda: 'CUDA',
  sycl: 'SYCL',
  hip: 'ROCm (HIP)',
  rocm: 'ROCm',
  opencl: 'OpenCL',
  metal: 'Metal',
  cpu: 'CPU',
}

export function parseDeviceId(id: string): { backend: string; index: number } {
  const match = /^([A-Za-z]+?)(\d+)$/.exec(id ?? '')
  if (!match) return { backend: id ?? '', index: 0 }
  return { backend: match[1], index: Number(match[2]) }
}

export function backendLabel(backend: string): string {
  return BACKEND_LABELS[backend.toLowerCase()] ?? backend.toUpperCase()
}

// Devices are joined to hardware-plugin GPUs by per-backend index, not by name:
// the same physical GPU appears at different indices under different backends.
export function findGpuForDevice(
  backend: string,
  index: number,
  gpus: GPU[]
): GPU | undefined {
  const key = backend.toLowerCase()
  if (key === 'vulkan') {
    return gpus.find((gpu) => gpu.vulkan_info?.index === index)
  }
  if (key === 'cuda') {
    return gpus.find((gpu) => gpu.nvidia_info?.index === index)
  }
  return undefined
}

export type ActiveDevice = DeviceList & { activated: boolean }

export interface GpuGroup {
  key: string
  name: string
  devices: ActiveDevice[]
}

const BACKEND_PRIORITY = [
  'cuda',
  'hip',
  'rocm',
  'sycl',
  'metal',
  'vulkan',
  'opencl',
]

function backendPriority(backend: string): number {
  const index = BACKEND_PRIORITY.indexOf(backend.toLowerCase())
  return index === -1 ? BACKEND_PRIORITY.length : index
}

// llama.cpp lists one device per backend, so a single physical GPU can appear
// as both CUDA0 and Vulkan0. Group by name and pair same-name devices by their
// per-backend enumeration order.
export function groupDevices(devices: ActiveDevice[]): GpuGroup[] {
  const byName = new Map<string, Map<string, ActiveDevice[]>>()
  for (const device of devices) {
    const { backend } = parseDeviceId(device.id)
    const backends = byName.get(device.name) ?? new Map()
    byName.set(device.name, backends)
    backends.set(backend, [...(backends.get(backend) ?? []), device])
  }

  const groups: GpuGroup[] = []
  for (const [name, backends] of byName) {
    const lists = [...backends.values()]
    for (const list of lists) {
      list.sort((a, b) => parseDeviceId(a.id).index - parseDeviceId(b.id).index)
    }
    const unitCount = Math.max(...lists.map((list) => list.length))
    for (let i = 0; i < unitCount; i++) {
      const unit = lists
        .map((list) => list[i])
        .filter((device): device is ActiveDevice => Boolean(device))
        .sort(
          (a, b) =>
            backendPriority(parseDeviceId(a.id).backend) -
            backendPriority(parseDeviceId(b.id).backend)
        )
      if (unit.length > 0) {
        groups.push({
          key: unit.map((device) => device.id).join('+'),
          name,
          devices: unit,
        })
      }
    }
  }
  return groups
}

// Activated device if any (units are priority-sorted), else the preferred one.
export function selectedDevice(group: GpuGroup): ActiveDevice {
  return group.devices.find((device) => device.activated) ?? group.devices[0]
}

/** The group a hardware-plugin GPU belongs to, found through any of its backend devices. */
export function groupForGpu(groups: GpuGroup[], gpu: GPU, gpus: GPU[]): GpuGroup | undefined {
  return groups.find((group) =>
    group.devices.some((device) => {
      const { backend, index } = parseDeviceId(device.id)
      return findGpuForDevice(backend, index, gpus)?.uuid === gpu.uuid
    })
  )
}
