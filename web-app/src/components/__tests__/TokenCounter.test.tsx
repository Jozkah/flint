import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TokenCounter } from '../TokenCounter'
import { useTokensCount } from '@/hooks/useTokensCount'
vi.mock('@/hooks/useTokensCount', () => ({
  useTokensCount: vi.fn(),
}))

// Mock tooltip components to render inline (Radix Portal + closed state prevents content from appearing in jsdom)
vi.mock('@/components/ui/tooltip', async () => {
  const React = await import('react')
  return {
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: React.forwardRef(({ children, asChild, ...props }: any, ref: any) => {
      if (asChild && React.isValidElement(children)) {
        return React.cloneElement(children as React.ReactElement, { ...props, ref })
      }
      return <span {...props} ref={ref}>{children}</span>
    }),
    TooltipContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="tooltip-content">{children}</div>
    ),
  }
})

const mockUseTokensCount = vi.mocked(useTokensCount)

function mockTokens(overrides: Partial<ReturnType<typeof useTokensCount>> = {}) {
  const defaults = {
    tokenCount: 0,
    maxTokens: 1000,
    calculateTokens: vi.fn(),
    ...overrides,
  }
  mockUseTokensCount.mockReturnValue(defaults)
  return defaults
}

describe('TokenCounter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTokens()
  })

  it('renders 0.0% when no messages and zero tokens', () => {
    render(<TokenCounter />)
    expect(screen.getAllByText('0.0%').length).toBeGreaterThanOrEqual(1)
  })

  it('renders correct percentage based on token count / max tokens', () => {
    mockTokens({ tokenCount: 500, maxTokens: 1000 })
    render(<TokenCounter />)
    expect(screen.getAllByText('50.0%').length).toBeGreaterThanOrEqual(1)
  })

  it('renders percentage with additionalTokens included', () => {
    mockTokens({ tokenCount: 200, maxTokens: 1000 })
    render(<TokenCounter additionalTokens={300} />)
    expect(screen.getAllByText('50.0%').length).toBeGreaterThanOrEqual(1)
  })

  it('warns in words, not only colour, before the window fills (AH-077)', () => {
    mockTokens({ tokenCount: 900, maxTokens: 1000 })
    render(<TokenCounter />)
    const warning = screen.getByTestId('context-pressure')
    expect(warning).toHaveAttribute('role', 'status')
    expect(warning).toHaveAttribute('data-tier', 'warn')
    expect(warning).toHaveTextContent('Nearly full')
    expect(screen.getByTestId('context-pressure-detail')).toHaveTextContent('100 tokens left')
    // The figures say where they came from: this one is Flint's own estimate.
    expect(screen.getByTestId('context-pressure-source')).toHaveTextContent(
      `${(900).toLocaleString()} of ${(1000).toLocaleString()} tokens, Flint's estimate`
    )
  })

  it('says the window is full once it is over', () => {
    mockTokens({ tokenCount: 1500, maxTokens: 1000 })
    render(<TokenCounter />)
    expect(screen.getByTestId('context-pressure')).toHaveAttribute('data-tier', 'over')
    expect(screen.getByTestId('context-pressure')).toHaveTextContent('Full')
  })

  it('does not warn with room to spare', () => {
    mockTokens({ tokenCount: 500, maxTokens: 1000 })
    render(<TokenCounter />)
    expect(screen.queryByTestId('context-pressure')).toBeNull()
    expect(screen.queryByTestId('context-pressure-detail')).toBeNull()
  })

  it('applies destructive styling when over limit (>100%)', () => {
    mockTokens({ tokenCount: 1500, maxTokens: 1000 })
    render(<TokenCounter />)
    const percentElements = screen.getAllByText('150.0%')
    expect(percentElements.length).toBeGreaterThanOrEqual(1)
    const span = percentElements[0]
    expect(span.className).toContain('text-destructive')
  })

  it('stays quiet when under limit', () => {
    mockTokens({ tokenCount: 500, maxTokens: 1000 })
    render(<TokenCounter />)
    const percentElements = screen.getAllByText('50.0%')
    const span = percentElements[0]
    // No tone of its own: it inherits the composer's muted text.
    expect(span.className).not.toContain('text-destructive')
    expect(span.className).not.toContain('text-warning')
  })

  it('calls calculateTokens when clicked', async () => {
    const user = userEvent.setup()
    const mocks = mockTokens({ tokenCount: 500, maxTokens: 1000 })
    const { container } = render(<TokenCounter />)
    const clickable = container.querySelector('.cursor-pointer')!
    await user.click(clickable)
    expect(mocks.calculateTokens).toHaveBeenCalledTimes(1)
  })

  it('renders the SVG progress ring', () => {
    mockTokens({ tokenCount: 500, maxTokens: 1000 })
    const { container } = render(<TokenCounter />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    const circles = container.querySelectorAll('circle')
    expect(circles.length).toBe(2)
    expect(container.querySelector('linearGradient stop')?.getAttribute('stop-color')).toBe('#22c55e')
  })

  it('changes ring gradient as context fills', () => {
    mockTokens({ tokenCount: 900, maxTokens: 1000 })
    const { container, unmount } = render(<TokenCounter />)
    expect(container.querySelector('linearGradient stop')?.getAttribute('stop-color')).toBe('#eab308')
    unmount()
    mockTokens({ tokenCount: 1100, maxTokens: 1000 })
    const full = render(<TokenCounter />)
    expect(full.container.querySelector('linearGradient stop')?.getAttribute('stop-color')).toBe('#f97316')
  })

  it('renders nothing when maxTokens is unavailable', () => {
    mockTokens({ tokenCount: 0, maxTokens: undefined })
    const { container } = render(<TokenCounter />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when maxTokens is 0', () => {
    mockTokens({ tokenCount: 0, maxTokens: 0 })
    const { container } = render(<TokenCounter />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a count-only badge (no percentage) when maxTokens is unavailable but tokens exist', () => {
    mockTokens({
      tokenCount: 1400,
      maxTokens: undefined,
      inputTokens: 1000,
      outputTokens: 400,
      modelDisplayName: 'GPT X',
    })
    render(<TokenCounter />)
    expect(screen.queryByText(/%/)).toBeNull()
    expect(screen.getAllByText('1.4K').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('GPT X')).toBeTruthy()
    // Exact count is grouped in the reader's locale, so derive the
    // expectation rather than hard-coding en-US separators.
    expect(screen.getByText((1400).toLocaleString())).toBeTruthy()
  })

  // Found by the real-provider scenario: a remote provider has no context
  // window, so the count-only popover is what the user sees, and it had no
  // session totals at all.
  it('shows the conversation totals, with cache-hit requests, in both popovers', async () => {
    const { finalizeTokenUsage } = await import('@/lib/tokenUsage')
    const meta = (input: number, cached?: number) => ({
      thread_id: 't1',
      metadata: {
        usage: finalizeTokenUsage({
          inputTokens: input,
          outputTokens: 5,
          cachedInputTokens: cached,
          requests: 1,
          cacheReportedRequests: cached === undefined ? 0 : 1,
          cacheHitRequests: (cached ?? 0) > 0 ? 1 : 0,
        }),
      },
    })
    const messages = [meta(2762, 810), meta(2808, 2785)] as any
    for (const maxTokens of [undefined, 100000]) {
      mockTokens({ tokenCount: 2831, maxTokens, inputTokens: 2808, outputTokens: 23 })
      const { unmount } = render(<TokenCounter messages={messages} />)
      const block = screen.getByTestId('session-usage')
      expect(block.dataset.requests).toBe('2')
      expect(block.dataset.cacheHitRequests).toBe('2')
      expect(screen.getByTestId('session-token-usage-cache-status').dataset.cacheStatus).toBe('reused')
      unmount()
    }
  })

  it('scopes the conversation totals to a source that hands its own in', () => {
    mockTokens({ tokenCount: 10, maxTokens: undefined, inputTokens: 5, outputTokens: 5 })
    render(
      <TokenCounter
        source={{ threadId: 'a', session: { inputTokens: 5, requests: 1, cacheReportedRequests: 0, cacheHitRequests: 0 } }}
        messages={[{ thread_id: 'b', metadata: { usage: { inputTokens: 999, requests: 1 } } }] as any}
      />
    )
    expect(screen.getByTestId('session-usage').dataset.usageScope).toBe('a')
    expect(screen.getByTestId('session-token-usage-cache-status').dataset.cacheStatus).toBe('not-reported')
  })

  describe('formatNumber helper (via rendered output)', () => {
    it('formats thousands as K', () => {
      mockTokens({ tokenCount: 1000, maxTokens: 2000 })
      const { container } = render(<TokenCounter />)
      expect(container.textContent).toContain('1.0K')
    })

    it('formats millions as M', () => {
      mockTokens({ tokenCount: 1000000, maxTokens: 2000000 })
      const { container } = render(<TokenCounter />)
      expect(container.textContent).toContain('1.0M')
    })

    it('shows raw number below 1000', () => {
      mockTokens({ tokenCount: 500, maxTokens: 1000 })
      const { container } = render(<TokenCounter />)
      expect(container.textContent).toContain('500')
    })
  })

  it('shows token breakdown with Total and Remaining labels', () => {
    mockTokens({ tokenCount: 500, maxTokens: 1000 })
    render(<TokenCounter />)
    const tooltipContent = screen.getAllByTestId('tooltip-content')[0]
    expect(tooltipContent.textContent).toContain('Total')
    expect(tooltipContent.textContent).toContain('Remaining')
  })

  describe('cache breakdown', () => {
    const value = (testId: string) =>
      screen.getByTestId(testId).getAttribute('data-value')

    it('itemises cached and uncached input when the provider reported a cache', () => {
      mockTokens({
        tokenCount: 5982,
        maxTokens: 32768,
        usage: {
          inputTokens: 5974,
          cachedInputTokens: 5957,
          uncachedInputTokens: 17,
          outputTokens: 8,
          totalTokens: 5982,
          cacheSource: 'openai-chat',
        },
      })
      render(<TokenCounter />)
      expect(value('token-usage-input')).toBe('5974')
      expect(value('token-usage-cached')).toBe('5957')
      expect(value('token-usage-uncached')).toBe('17')
      expect(value('token-usage-output')).toBe('8')
      expect(value('token-usage-total')).toBe('5982')
      expect(screen.getByTestId('token-usage-cache-bar')).toBeTruthy()
      expect(screen.queryByTestId('token-usage-cache-unreported')).toBeNull()
      // Reported by Anthropic only, so no write row here.
      expect(screen.queryByTestId('token-usage-cache-write')).toBeNull()
    })

    it('explains that uncached input is derived and is not a count of cache misses', () => {
      mockTokens({
        tokenCount: 110,
        maxTokens: 1000,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 60,
          uncachedInputTokens: 40,
          outputTokens: 10,
          totalTokens: 110,
        },
      })
      render(<TokenCounter />)
      const note = screen.getByTestId('token-usage-uncached-note')
      expect(note.getAttribute('aria-label')).toMatch(/input tokens minus cached input tokens/i)
      expect(note.getAttribute('aria-label')).toMatch(/not a number of cache-miss events/i)
      // The label itself never calls the figure "misses".
      expect(screen.getByTestId('token-usage-uncached').textContent).toMatch(
        /^Uncached input/
      )
      expect(screen.queryByText(/cache misses?$/i)).toBeNull()
    })

    it('shows a cache write row, reported by Anthropic, as part of the uncached input', () => {
      mockTokens({
        tokenCount: 2318,
        maxTokens: undefined,
        usage: {
          inputTokens: 2312,
          cachedInputTokens: 2000,
          uncachedInputTokens: 312,
          cacheWriteTokens: 300,
          outputTokens: 6,
          totalTokens: 2318,
          cacheSource: 'anthropic',
        },
      })
      render(<TokenCounter />)
      expect(value('token-usage-cache-write')).toBe('300')
      // Not added twice: total is input + output.
      expect(value('token-usage-total')).toBe('2318')
    })

    it('says "Not reported" instead of showing 0 cached when the provider sent no cache data', () => {
      mockTokens({
        tokenCount: 6103,
        maxTokens: undefined,
        usage: { inputTokens: 6100, outputTokens: 3, totalTokens: 6103 },
      })
      render(<TokenCounter />)
      const row = screen.getByTestId('token-usage-cache-unreported')
      expect(row.textContent).toContain('Not reported')
      expect(row.getAttribute('data-value')).toBeNull()
      expect(screen.queryByTestId('token-usage-cached')).toBeNull()
      expect(screen.queryByTestId('token-usage-uncached')).toBeNull()
      expect(screen.queryByTestId('token-usage-cache-bar')).toBeNull()
      expect(screen.getByTestId('tooltip-content').textContent).not.toMatch(/Cached input\s*0/)
    })

    it('shows a measured zero as zero', () => {
      mockTokens({
        tokenCount: 5982,
        maxTokens: 32768,
        usage: {
          inputTokens: 5974,
          cachedInputTokens: 0,
          uncachedInputTokens: 5974,
          outputTokens: 8,
          totalTokens: 5982,
        },
      })
      render(<TokenCounter />)
      expect(value('token-usage-cached')).toBe('0')
      expect(value('token-usage-uncached')).toBe('5974')
    })

    it('flags clamped provider values with what was actually reported', () => {
      mockTokens({
        tokenCount: 101,
        maxTokens: 1000,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 100,
          uncachedInputTokens: 0,
          outputTokens: 1,
          totalTokens: 101,
          reported: { cachedInputTokens: 250 },
        },
      })
      render(<TokenCounter />)
      expect(screen.getByTestId('token-usage-clamped').textContent).toContain('250')
    })

    // The restart check's first attempt once read Chat's numbers while
    // asserting Cowork's: a portalled popover from the previous surface was
    // still in the document. Every surface stamps its session on the badge and
    // the breakdown, so a switch can be told apart deterministically.
    it('stamps the session on badge and breakdown, and follows a session switch', () => {
      const a = {
        inputTokens: 2801,
        cachedInputTokens: 2778,
        uncachedInputTokens: 23,
        outputTokens: 24,
        totalTokens: 2825,
      }
      const b = {
        inputTokens: 5900,
        cachedInputTokens: 5863,
        uncachedInputTokens: 37,
        outputTokens: 32,
        totalTokens: 5932,
      }
      mockUseTokensCount.mockImplementation(((_m: unknown, source?: { threadId?: string }) => ({
        tokenCount: source?.threadId === 'session-b' ? b.totalTokens : a.totalTokens,
        maxTokens: undefined,
        usage: source?.threadId === 'session-b' ? b : a,
        calculateTokens: vi.fn(),
      })) as never)
      const { rerender } = render(
        <TokenCounter source={{ threadId: 'session-a', usage: a }} />
      )
      expect(screen.getByTestId('token-counter').getAttribute('data-usage-scope')).toBe('session-a')
      expect(screen.getByTestId('token-usage-breakdown').getAttribute('data-usage-scope')).toBe(
        'session-a'
      )
      expect(value('token-usage-input')).toBe('2801')

      rerender(<TokenCounter source={{ threadId: 'session-b', usage: b }} />)
      expect(screen.getByTestId('token-counter').getAttribute('data-usage-scope')).toBe('session-b')
      expect(screen.getByTestId('token-usage-breakdown').getAttribute('data-usage-scope')).toBe(
        'session-b'
      )
      expect(value('token-usage-input')).toBe('5900')
      expect(value('token-usage-cached')).toBe('5863')
    })

    it('keeps the compact counter free of the breakdown', () => {
      mockTokens({
        tokenCount: 5982,
        maxTokens: undefined,
        usage: {
          inputTokens: 5974,
          cachedInputTokens: 5957,
          uncachedInputTokens: 17,
          outputTokens: 8,
          totalTokens: 5982,
        },
      })
      render(<TokenCounter />)
      const trigger = screen.getByTestId('token-counter')
      expect(trigger.textContent).toBe('6.0K')
    })
  })

  it('shows Context window header', () => {
    mockTokens({ tokenCount: 500, maxTokens: 1000 })
    render(<TokenCounter />)
    expect(
      screen.getByTestId('tooltip-content').textContent
    ).toContain('Context window')
  })

  it('shows correct remaining tokens', () => {
    mockTokens({ tokenCount: 300, maxTokens: 1000 })
    const { container } = render(<TokenCounter />)
    const tooltipContent = screen.getByTestId('tooltip-content')
    expect(tooltipContent.textContent).toContain('700')
  })

  it('shows 0 remaining when over limit', () => {
    mockTokens({ tokenCount: 1500, maxTokens: 1000 })
    const { container } = render(<TokenCounter />)
    const tooltipContent = screen.getByTestId('tooltip-content')
    expect(tooltipContent.textContent).toContain('Remaining')
    expect(tooltipContent.textContent).toMatch(/Remaining\s*0/)
  })

  it('shows the overflow note and failing-request numbers when isOverflow', () => {
    mockTokens({ tokenCount: 1200, maxTokens: 1000, isOverflow: true })
    const { container } = render(<TokenCounter />)
    const tooltipContent = screen.getByTestId('tooltip-content')
    expect(tooltipContent.textContent).toMatch(/overflow/i)
    expect(screen.getAllByText('120.0%').length).toBeGreaterThanOrEqual(1)
  })

  it('does not show the overflow note when not overflowing', () => {
    mockTokens({ tokenCount: 500, maxTokens: 1000, isOverflow: false })
    render(<TokenCounter />)
    expect(screen.getByTestId('tooltip-content').textContent).not.toMatch(
      /overflow/i
    )
  })

  it('accepts className prop', () => {
    mockTokens({ tokenCount: 0, maxTokens: 1000 })
    const { container } = render(<TokenCounter className="custom-class" />)
    const wrapper = container.querySelector('.custom-class')
    expect(wrapper).toBeTruthy()
  })
})
