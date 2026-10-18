import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
const getActiveModels = vi.fn<() => Promise<string[]>>()
vi.mock('@/hooks/useServiceHub', () => {
  const hub = { models: () => ({ getActiveModels }) }
  return { useServiceHub: () => hub }
})

import { ActiveModelsSync, ACTIVE_MODELS_POLL_MS } from '../ActiveModelsSync'
import { useAppState } from '@/hooks/useAppState'

const flush = () => act(async () => {})

describe('ActiveModelsSync (SH-001)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppState.setState({ activeModels: [], loadingModel: false, loadingModels: {} })
    getActiveModels.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('reads the loaded models on mount, on any page', async () => {
    getActiveModels.mockResolvedValue(['qwen3-8b'])
    render(<ActiveModelsSync />)
    await flush()
    expect(useAppState.getState().activeModels).toEqual(['qwen3-8b'])
  })

  it('picks up a model the router loaded for a chat when the load ends', async () => {
    getActiveModels.mockResolvedValue([])
    render(<ActiveModelsSync />)
    await flush()
    getActiveModels.mockResolvedValue(['qwen3-8b'])
    act(() => useAppState.setState({ loadingModel: true }))
    act(() => useAppState.setState({ loadingModel: false }))
    await flush()
    expect(useAppState.getState().activeModels).toEqual(['qwen3-8b'])
  })

  it('polls while visible, so a load nothing announced still shows', async () => {
    getActiveModels.mockResolvedValue([])
    render(<ActiveModelsSync />)
    await flush()
    getActiveModels.mockResolvedValue(['gemma'])
    await act(async () => {
      vi.advanceTimersByTime(ACTIVE_MODELS_POLL_MS)
    })
    expect(useAppState.getState().activeModels).toEqual(['gemma'])
  })
})
