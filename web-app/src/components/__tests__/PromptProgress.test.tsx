import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { PromptProgress } from '../PromptProgress'
import { useAppState } from '@/hooks/useAppState'

// Mock the useAppState hook
vi.mock('@/hooks/useAppState', () => ({
  useAppState: vi.fn(),
}))

const route = vi.hoisted(() => ({ params: undefined as { threadId: string } | undefined }))

vi.mock('@tanstack/react-router', () => ({
  useParams: () => route.params,
}))

const mockUseAppState = useAppState as ReturnType<typeof vi.fn>

describe('PromptProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.params = undefined
  })

  it('shows the failed card when the thread has a stamped model load failure', () => {
    route.params = { threadId: 't1' }
    mockUseAppState.mockImplementation((selector) =>
      selector({
        promptProgress: undefined,
        promptProgresses: {},
        loadingModel: false,
        loadingModels: {},
        modelLoadFailures: { t1: Date.now() },
        modelLoadProgressByThread: {},
      })
    )

    render(<PromptProgress />)

    expect(screen.getByTestId('model-loader')).toHaveTextContent(/common:modelLoader.failed/)
  })

  it('does not show a failure for another thread', () => {
    route.params = { threadId: 't1' }
    mockUseAppState.mockImplementation((selector) =>
      selector({
        promptProgress: undefined,
        promptProgresses: {},
        loadingModel: false,
        loadingModels: {},
        modelLoadFailures: { other: Date.now() },
        modelLoadProgressByThread: {},
      })
    )

    render(<PromptProgress hideIdle />)

    expect(screen.queryByTestId('model-loader')).toBeNull()
  })

  it('offers to stop the running tool once it has run for 30 seconds', () => {
    vi.useFakeTimers()
    try {
      mockUseAppState.mockImplementation((selector) =>
        selector({ promptProgress: undefined, loadingModel: false })
      )
      const onStopTool = vi.fn()
      const status = {
        phase: 'tool' as const,
        key: 'tool:c1',
        callId: 'c1',
        label: () => 'Running bash…',
      }
      const { rerender } = render(<PromptProgress status={status} onStopTool={onStopTool} />)
      expect(screen.queryByTestId('run-status-stop-tool')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(31_000)
      })
      rerender(<PromptProgress status={status} onStopTool={onStopTool} />)
      screen.getByTestId('run-status-stop-tool').click()
      expect(onStopTool).toHaveBeenCalledWith('c1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('should calculate percentage correctly', () => {
    const mockProgress = {
      cache: 0,
      processed: 75,
      time_ms: 1500,
      total: 150,
    }

    mockUseAppState.mockImplementation((selector) =>
      selector({ promptProgress: mockProgress, loadingModel: false })
    )

    render(<PromptProgress />)

    expect(screen.getByText('Reading: 50%')).toBeInTheDocument()
  })

  it('should show token counts and ETA while reading', () => {
    const mockProgress = {
      cache: 0,
      processed: 1200,
      time_ms: 3000,
      total: 2600,
    }

    mockUseAppState.mockImplementation((selector) =>
      selector({ promptProgress: mockProgress, loadingModel: false })
    )

    render(<PromptProgress />)

    expect(screen.getByText('Reading: 46%')).toBeInTheDocument()
    // 1200/2600 tokens, ETA = (3000/1200)*1400 = 3500ms -> 4s
    expect(
      screen.getByText('1.2k / 2.6k tokens · ~4s left')
    ).toBeInTheDocument()
  })

  it('should show load percentage while loading model', () => {
    mockUseAppState.mockImplementation((selector) =>
      selector({
        promptProgress: undefined,
        loadingModel: true,
        modelLoadProgress: { modelId: 'model-1', value: 0.42 },
      })
    )

    render(<PromptProgress />)

    expect(screen.getByText('Loading model: 42%')).toBeInTheDocument()
  })

  it('should not render a progress bar while loading a model', () => {
    mockUseAppState.mockImplementation((selector) =>
      selector({
        promptProgress: undefined,
        loadingModel: true,
        modelLoadProgress: { modelId: 'model-1', value: 0.42 },
      })
    )

    const { container } = render(<PromptProgress />)

    expect(screen.getByText('Loading model: 42%')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="progress"]')).toBeNull()
  })

  it('should still render the progress bar while reading (unaffected by the load-bar removal)', () => {
    const mockProgress = { cache: 0, processed: 50, time_ms: 500, total: 100 }
    mockUseAppState.mockImplementation((selector) =>
      selector({ promptProgress: mockProgress, loadingModel: false })
    )

    const { container } = render(<PromptProgress />)

    expect(container.querySelector('[data-slot="progress"]')).not.toBeNull()
  })

  it('should name the stage when a load has more than one (vision model)', () => {
    mockUseAppState.mockImplementation((selector) =>
      selector({
        promptProgress: undefined,
        loadingModel: true,
        modelLoadProgress: {
          modelId: 'model-1',
          value: 0.8,
          stage: 'mmproj_model',
          stages: ['text_model', 'mmproj_model'],
        },
      })
    )

    render(<PromptProgress />)

    expect(screen.getByText('Loading vision encoder: 80%')).toBeInTheDocument()
  })

  it('should not name the stage for a plain single-stage text-only load', () => {
    mockUseAppState.mockImplementation((selector) =>
      selector({
        promptProgress: undefined,
        loadingModel: true,
        modelLoadProgress: {
          modelId: 'model-1',
          value: 0.5,
          stage: 'text_model',
          stages: ['text_model'],
        },
      })
    )

    render(<PromptProgress />)

    expect(screen.getByText('Loading model: 50%')).toBeInTheDocument()
  })

  it('should fall back to generic loading label when no progress event has arrived yet', () => {
    mockUseAppState.mockImplementation((selector) =>
      selector({
        promptProgress: undefined,
        loadingModel: true,
        modelLoadProgress: undefined,
      })
    )

    render(<PromptProgress />)

    expect(screen.getByText('Loading model…')).toBeInTheDocument()
  })

  it('should handle zero total gracefully', () => {
    const mockProgress = {
      cache: 0,
      processed: 0,
      time_ms: 0,
      total: 0,
    }

    mockUseAppState.mockImplementation((selector) =>
      selector({ promptProgress: mockProgress, loadingModel: false })
    )

    const { container } = render(<PromptProgress />)

    // Component should render Loader when total is 0
    const loader = container.querySelector('svg.animate-spin')
    expect(loader).not.toBeNull()
    expect(loader?.classList.contains('animate-spin')).toBe(true)
  })
})

describe('PromptProgress loaded state', () => {
  it('holds a Loaded in card briefly after the load ends', async () => {
    vi.useFakeTimers()
    const { act } = await import('@testing-library/react')
    let loading = true
    mockUseAppState.mockImplementation((selector) =>
      selector({ promptProgress: undefined, loadingModel: loading })
    )
    const { rerender } = render(<PromptProgress />)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    loading = false
    rerender(<PromptProgress />)
    expect(screen.getByText('common:modelLoader.done')).toBeInTheDocument()
    expect(screen.getByTestId('model-loader-elapsed')).toHaveTextContent('3s')
    act(() => {
      vi.advanceTimersByTime(1300)
    })
    expect(screen.queryByText('common:modelLoader.done')).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('stops the clock and says who it waits for while blocked on the user', () => {
    mockUseAppState.mockImplementation((selector) =>
      selector({
        promptProgress: undefined,
        promptProgresses: {},
        loadingModel: false,
        loadingModels: {},
        modelLoadFailures: {},
        modelLoadProgressByThread: {},
      })
    )
    const status = { phase: 'tool' as const, key: 'tool:1', label: () => 'Running bash…' }
    render(<PromptProgress status={status} waitingLabel="Waiting for you" />)
    expect(screen.getByTestId('run-status-label')).toHaveTextContent('Waiting for you')
    expect(screen.queryByTestId('run-status-elapsed')).toBeNull()
  })
})

describe('PromptProgress since', () => {
  it('counts elapsed from the given time, not from mount', () => {
    mockUseAppState.mockImplementation((selector) =>
      selector({
        promptProgress: undefined,
        promptProgresses: {},
        loadingModel: false,
        loadingModels: {},
        modelLoadFailures: {},
        modelLoadProgressByThread: {},
      })
    )
    const status = { phase: 'waiting' as const, key: 'quiet', label: () => 'Still waiting for the model…' }
    render(<PromptProgress status={status} since={Date.now() - 12_000} />)
    expect(screen.getByTestId('run-status-elapsed')).toHaveTextContent('12s')
  })
})
