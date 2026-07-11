import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PromptProgress } from '../PromptProgress'
import { useAppState } from '@/hooks/useAppState'

// Mock the useAppState hook
vi.mock('@/hooks/useAppState', () => ({
  useAppState: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useParams: () => undefined,
}))

const mockUseAppState = useAppState as ReturnType<typeof vi.fn>

describe('PromptProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
