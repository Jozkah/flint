import { create } from 'zustand'

/** Where the engine put a model's weights when it last loaded. */
export type GpuOffload = {
  /** Layers in device memory. */
  gpuLayers: number
  totalLayers: number
  /** Weights in device memory, MiB. */
  gpuMib: number
  /** Weights in host memory, MiB. */
  cpuMib: number
}

/** The `llamacpp-offload` event payload, as the engine reports it. */
export type GpuOffloadEvent = {
  model?: string | null
  gpu_layers: number
  total_layers: number
  gpu_mib: number
  cpu_mib: number
}

type GpuOffloadState = {
  /** Reports the engine tagged with a model id. */
  byModel: Record<string, GpuOffload>
  /**
   * The newest report, tagged or not. A load the engine did not tag belongs to
   * whichever model was loading, which only the caller knows.
   */
  latest?: GpuOffload & { model?: string }
  record: (event: GpuOffloadEvent) => void
  forget: (modelId: string) => void
}

export const useGpuOffload = create<GpuOffloadState>()((set) => ({
  byModel: {},
  latest: undefined,
  record: (event) => {
    const offload: GpuOffload = {
      gpuLayers: event.gpu_layers,
      totalLayers: event.total_layers,
      gpuMib: event.gpu_mib,
      cpuMib: event.cpu_mib,
    }
    const model = event.model || undefined
    set((state) => ({
      latest: { ...offload, ...(model ? { model } : {}) },
      byModel: model ? { ...state.byModel, [model]: offload } : state.byModel,
    }))
  },
  forget: (modelId) =>
    set((state) => {
      const byModel = { ...state.byModel }
      delete byModel[modelId]
      return {
        byModel,
        latest: state.latest?.model === modelId ? undefined : state.latest,
      }
    }),
}))

/**
 * What to show for a loaded model: its own report when the engine tagged one,
 * otherwise the newest untagged one while it is the only model loaded (an
 * untagged report cannot be told apart from another model's).
 */
export function offloadFor(
  state: Pick<GpuOffloadState, 'byModel' | 'latest'>,
  modelId: string,
  activeModels: readonly string[]
): GpuOffload | undefined {
  const own = state.byModel[modelId]
  if (own) return own
  const latest = state.latest
  if (!latest || latest.model) return undefined
  return activeModels.length === 1 && activeModels[0] === modelId
    ? latest
    : undefined
}
