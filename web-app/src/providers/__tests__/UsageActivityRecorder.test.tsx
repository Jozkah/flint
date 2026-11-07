import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { UsageActivityRecorder } from '../UsageActivityRecorder'
import { useAppState } from '@/hooks/useAppState'
import { activityText, useUsageStats } from '@/stores/usage-stats-store'

const kinds = () => useUsageStats.getState().activity.map((a) => a.kind)

describe('UsageActivityRecorder (LIBC-030)', () => {
  beforeEach(() => {
    useAppState.setState({ activeModels: [], activeModelsSynced: false })
    useUsageStats.setState({ activity: [] })
  })

  it('does not log models that were already loaded at start-up', () => {
    render(<UsageActivityRecorder />)
    act(() => {
      useAppState.setState({ activeModels: ['qwen'], activeModelsSynced: true })
    })
    expect(kinds()).toEqual([])
  })

  it('logs a model loaded after the first sync', () => {
    render(<UsageActivityRecorder />)
    act(() => {
      useAppState.setState({ activeModels: [], activeModelsSynced: true })
    })
    act(() => {
      useAppState.setState({ activeModels: ['qwen'] })
    })
    expect(kinds()).toEqual(['model-loaded'])
  })

  it('logs a plain unload', () => {
    render(<UsageActivityRecorder />)
    act(() => {
      useAppState.setState({ activeModels: ['qwen'], activeModelsSynced: true })
    })
    act(() => {
      useAppState.setState({ activeModels: [] })
    })
    expect(kinds()).toEqual(['model-unloaded'])
  })

  it('stores the title key so the feed follows the UI language', () => {
    render(<UsageActivityRecorder />)
    act(() => {
      useAppState.setState({ activeModels: [], activeModelsSynced: true })
    })
    act(() => {
      useAppState.setState({ activeModels: ['qwen'] })
    })
    const [item] = useUsageStats.getState().activity
    expect(item.titleKey).toBe('overview:activityModelLoaded')
    expect(activityText(item, (k) => `T(${k})`).title).toBe('T(overview:activityModelLoaded)')
  })
})
