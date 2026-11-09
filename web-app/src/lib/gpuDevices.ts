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

const isVulkan = (id: string) =>
  parseDeviceId(id).backend.toLowerCase() === 'vulkan'

/**
 * Find the hardware-plugin GPU behind a llama.cpp device.
 *
 * llama.cpp's `Vulkan<N>` is a position among the devices it kept (filtered and
 * reordered by `GGML_VK_VISIBLE_DEVICES`, hybrid-graphics setups), while the
 * plugin's `vulkan_info.index` is the raw enumeration index. Joining on the
 * number attaches one GPU to another's card, so Vulkan devices are joined by
 * name instead. Names are not always equal: the plugin keeps the NVML name for
 * NVIDIA cards and Vulkan's `deviceName` for the rest. So when exactly one
 * Vulkan device and one GPU are left unmatched by name, they are paired.
 * Identical twin cards, which a name cannot tell apart, are paired by rank
 * among same-named devices. Two or more differently named mismatches are left
 * blank rather than guessed. CUDA numbering is the plugin's own, so it stays
 * index-based.
 */
export function findGpuForDevice(
  device: { id: string; name: string },
  gpus: GPU[],
  allDevices: { id: string; name: string }[] = [device]
): GPU | undefined {
  const { backend, index } = parseDeviceId(device.id)
  if (backend.toLowerCase() === 'cuda') {
    return gpus.find((gpu) => gpu.nvidia_info?.index === index)
  }
  if (backend.toLowerCase() !== 'vulkan') return undefined

  const vulkanGpus = gpus.filter((gpu) => gpu.vulkan_info)
  const named = vulkanGpus.filter((gpu) => gpu.name === device.name)
  if (named.length === 1) return named[0]
  if (named.length > 1) {
    // The plugin numbers every physical device, llama.cpp only the ones it
    // kept, so the raw numbers disagree. Pair twins by rank instead.
    const rank = allDevices
      .filter((d) => isVulkan(d.id) && d.name === device.name)
      .map((d) => parseDeviceId(d.id).index)
      .sort((a, b) => a - b)
      .indexOf(index)
    return [...named].sort(
      (a, b) => (a.vulkan_info?.index ?? 0) - (b.vulkan_info?.index ?? 0)
    )[rank]
  }

  const vulkanDevices = allDevices.filter((d) => isVulkan(d.id))
  const unmatchedDevices = vulkanDevices.filter(
    (d) => !vulkanGpus.some((gpu) => gpu.name === d.name)
  )
  const unmatchedGpus = vulkanGpus.filter(
    (gpu) => !vulkanDevices.some((d) => d.name === gpu.name)
  )
  return unmatchedDevices.length === 1 && unmatchedGpus.length === 1
    ? unmatchedGpus[0]
    : undefined
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
  const allDevices = groups.flatMap((group) => group.devices)
  return groups.find((group) =>
    group.devices.some(
      (device) => findGpuForDevice(device, gpus, allDevices)?.uuid === gpu.uuid
    )
  )
}
