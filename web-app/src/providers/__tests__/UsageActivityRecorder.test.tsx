import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { UsageActivityRecorder } from '../UsageActivityRecorder'
import { useAppState } from '@/hooks/useAppState'
import { useUsageStats } from '@/stores/usage-stats-store'

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
})
