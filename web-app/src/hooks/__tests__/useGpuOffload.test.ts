import { beforeEach, describe, expect, it } from 'vitest'
import {
  offloadFor,
  useGpuOffload,
  type GpuOffloadEvent,
} from '../useGpuOffload'

const report = (over: Partial<GpuOffloadEvent> = {}): GpuOffloadEvent => ({
  gpu_layers: 33,
  total_layers: 33,
  gpu_mib: 4000,
  cpu_mib: 300,
  ...over,
})
const record = (e: GpuOffloadEvent) => useGpuOffload.getState().record(e)

describe('useGpuOffload', () => {
  beforeEach(() => {
    useGpuOffload.setState({ byModel: {}, latest: undefined })
  })

  it('keeps a tagged report under its model', () => {
    record(report({ model: 'qwen' }))
    const state = useGpuOffload.getState()
    expect(offloadFor(state, 'qwen', ['qwen', 'llama'])).toEqual({
      gpuLayers: 33,
      totalLayers: 33,
      gpuMib: 4000,
      cpuMib: 300,
    })
    expect(offloadFor(state, 'llama', ['qwen', 'llama'])).toBeUndefined()
  })

  it('attributes an untagged report only to a sole loaded model', () => {
    record(report({ gpu_layers: 10 }))
    const state = useGpuOffload.getState()
    expect(offloadFor(state, 'qwen', ['qwen'])?.gpuLayers).toBe(10)
    expect(offloadFor(state, 'qwen', ['qwen', 'llama'])).toBeUndefined()
  })

  it('forgets a model when it unloads', () => {
    record(report({ model: 'qwen' }))
    useGpuOffload.getState().forget('qwen')
    const state = useGpuOffload.getState()
    expect(offloadFor(state, 'qwen', ['qwen'])).toBeUndefined()
    expect(state.latest).toBeUndefined()
  })
})
