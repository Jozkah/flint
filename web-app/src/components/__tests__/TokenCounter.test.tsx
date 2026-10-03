import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TokenCounter } from '../TokenCounter'
import { useTokensCount } from '@/hooks/useTokensCount'
import { useContextBreakdown } from '@/hooks/useContextBreakdown'
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

// The info tooltips render inline here too, so the popover is the first one.
const popover = () => screen.getAllByTestId('tooltip-content')[0]

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
    const percentElements = screen.getAllByText('100.0%')
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

  // Theme tokens, not hex: the ring has to follow light and dark mode.
  const stopColor = (container: Element) =>
    (container.querySelector('linearGradient stop') as SVGStopElement | null)?.style.stopColor

  it('renders the SVG progress ring', () => {
    mockTokens({ tokenCount: 500, maxTokens: 1000 })
    const { container } = render(<TokenCounter />)
    const ring = screen.getByTestId('context-ring')
    expect(ring.querySelectorAll('circle').length).toBe(2)
    expect(stopColor(container)).toBe('var(--success)')
  })

  it('changes ring gradient as context fills', () => {
    mockTokens({ tokenCount: 900, maxTokens: 1000 })
    const { container, unmount } = render(<TokenCounter />)
    expect(stopColor(container)).toBe('var(--warning)')
    unmount()
    mockTokens({ tokenCount: 1100, maxTokens: 1000 })
    const full = render(<TokenCounter />)
    expect(stopColor(full.container)).toBe('var(--warning)')
    // The far end of the ring is the destructive token, not a fixed hex.
    expect(
      (full.container.querySelectorAll('linearGradient stop')[1] as SVGStopElement).style.stopColor
    ).toBe('var(--destructive)')
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
    // The trigger is a circle; the total is said to a screen reader and shown on hover.
    expect(screen.getByText('Token usage 1.4K')).toBeTruthy()
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
      expect(block.textContent).toContain('2 requests')
      expect(screen.getByTestId('session-token-usage-cache-status').dataset.cacheStatus).toBe('reused')
      unmount()
    }
  })

  it('scopes the conversation totals to a source that hands its own in', () => {
    mockTokens({ tokenCount: 10, maxTokens: undefined, inputTokens: 5, outputTokens: 5 })
    render(
      <TokenCounter
        source={{ threadId: 'a', session: { inputTokens: 5, requests: 3, cacheReportedRequests: 0, cacheHitRequests: 0 } }}
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

  it('shows the last reply with its Total, and no conversation block for a single request', () => {
    mockTokens({ tokenCount: 500, maxTokens: 1000, usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 } })
    render(<TokenCounter />)
    const tooltipContent = popover()
    expect(tooltipContent.textContent).toContain('Last reply')
    expect(tooltipContent.textContent).toContain('Total')
    expect(screen.queryByTestId('session-usage')).toBeNull()
  })

  it('keeps jargon out of the visible text, and the provenance in tooltips', () => {
    mockTokens({
      tokenCount: 110,
      maxTokens: undefined,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 60,
        uncachedInputTokens: 40,
        outputTokens: 10,
        totalTokens: 110,
        cacheSource: 'openai-chat',
      },
    })
    render(<TokenCounter />)
    const text = Array.from(screen.getAllByTestId('tooltip-content'))
      .map((el) => el.textContent)
      .join(' ')
    // Tooltips are inline in this test, so look at what is NOT inside one.
    const visible = screen.getByTestId('token-usage-breakdown').cloneNode(true) as HTMLElement
    visible.querySelectorAll('[data-testid="tooltip-content"]').forEach((n) => n.remove())
    expect(visible.textContent).not.toMatch(/derived|prompt_tokens_details|cached_tokens|Uncached/)
    expect(text).toMatch(/Input plus output/)
    expect(text).toMatch(/usage report/)
  })

  describe('cache breakdown', () => {
    const attr = (testId: string, name = 'value') =>
      screen.getByTestId(testId).getAttribute(`data-${name}`)

    it('shows input with how much was cached, output and total when the provider reported a cache', () => {
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
      expect(attr('token-usage-input')).toBe('5974')
      expect(attr('token-usage-input', 'cached')).toBe('5957')
      expect(attr('token-usage-input', 'uncached')).toBe('17')
      expect(attr('token-usage-output')).toBe('8')
      expect(attr('token-usage-total')).toBe('5982')
      expect(screen.getByTestId('token-usage-cache-bar')).toBeTruthy()
      expect(screen.getByTestId('token-usage-cache-status').textContent).toBe('100% cached')
      expect(attr('token-usage-input', 'cache-write')).toBeNull()
    })

    it('says in a tooltip, not in a row, what the cached split means', () => {
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
      const note = screen.getByTestId('token-usage-cache-note')
      expect(note.getAttribute('aria-label')).toMatch(/60 read from the cache, 40 new/)
      expect(screen.queryByText(/cache misses?$/i)).toBeNull()
    })

    it('notes a cache write, reported by Anthropic, in the same tooltip; total stays input plus output', () => {
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
      expect(attr('token-usage-input', 'cache-write')).toBe('300')
      expect(screen.getByTestId('token-usage-cache-note').getAttribute('aria-label')).toMatch(
        /300 written to the cache/
      )
      expect(attr('token-usage-total')).toBe('2318')
    })

    it('shows no cache figure instead of 0 when the provider sent no cache data', () => {
      mockTokens({
        tokenCount: 6103,
        maxTokens: undefined,
        usage: { inputTokens: 6100, outputTokens: 3, totalTokens: 6103 },
      })
      render(<TokenCounter />)
      expect(attr('token-usage-input', 'cached')).toBeNull()
      expect(screen.getByTestId('token-usage-cache-status').getAttribute('data-cache-status')).toBe(
        'not-reported'
      )
      expect(screen.queryByTestId('token-usage-cache-bar')).toBeNull()
      expect(screen.getByTestId('token-usage-cache-note').getAttribute('aria-label')).toMatch(
        /did not report/
      )
      expect(screen.getByTestId('token-usage-breakdown').textContent).not.toMatch(/Cached\s*0/)
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
      expect(attr('token-usage-input', 'cached')).toBe('0')
      expect(attr('token-usage-input', 'uncached')).toBe('5974')
      expect(screen.getByTestId('token-usage-cache-status').getAttribute('data-cache-status')).toBe('none')
    })

    it('says what the provider actually reported when it was clamped', () => {
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
      expect(screen.getByTestId('token-usage-cache-note').getAttribute('aria-label')).toContain('250')
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
      expect(attr('token-usage-input')).toBe('2801')

      rerender(<TokenCounter source={{ threadId: 'session-b', usage: b }} />)
      expect(screen.getByTestId('token-counter').getAttribute('data-usage-scope')).toBe('session-b')
      expect(screen.getByTestId('token-usage-breakdown').getAttribute('data-usage-scope')).toBe(
        'session-b'
      )
      expect(attr('token-usage-input')).toBe('5900')
      expect(attr('token-usage-input', 'cached')).toBe('5863')
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
      expect(trigger.textContent).toBe('Token usage 6.0K')
      expect(trigger.textContent).not.toContain('5,974')
    })
  })

  describe('the circle', () => {
    it('shows no number on the trigger, only the ring, and says the fill in words', () => {
      mockTokens({ tokenCount: 370, maxTokens: 1000 })
      render(<TokenCounter />)
      const trigger = screen.getByTestId('token-counter')
      expect(trigger.querySelector('svg')).toBeTruthy()
      expect(trigger.querySelector('.sr-only')?.textContent).toBe('Context 37% full')
      // Nothing but the screen-reader text is text.
      expect(trigger.textContent).toBe('Context 37% full')
    })

    it('is a circle for a provider with no window size too, dashed and empty', () => {
      mockTokens({ tokenCount: 1400, maxTokens: undefined })
      render(<TokenCounter />)
      const ring = screen.getByTestId('context-ring')
      expect(ring.getAttribute('data-window')).toBe('unknown')
      expect(ring.querySelectorAll('circle')).toHaveLength(1)
    })

    it('draws the arc to the same fraction the bar uses', () => {
      useContextBreakdown.setState({
        byId: {
          t1: {
            at: 1,
            segments: [
              { id: 'messages' as const, label: 'Messages', tokens: 300, color: 'bg-blue-500' },
            ],
          },
        },
      })
      mockTokens({ tokenCount: 250, maxTokens: 1000 })
      render(<TokenCounter source={{ threadId: 't1' }} />)
      const ring = screen.getByTestId('context-ring')
      expect(ring.getAttribute('data-fraction')).toBe('0.2500')
      const arc = ring.querySelectorAll('circle')[1]
      const c = 2 * Math.PI * 8
      expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(c * 0.75, 3)
      const bar = screen.getByTestId('context-bar')
      expect(
        Number.parseFloat(
          (bar.querySelector('[data-segment="messages"]') as HTMLElement).style.width
        )
      ).toBeCloseTo(25, 5)
      expect(screen.getByText(/250 \/ 1\.0K \(25%\)/)).toBeTruthy()
      useContextBreakdown.setState({ byId: {} })
    })

    it('clamps the arc when usage is past the window', () => {
      mockTokens({ tokenCount: 5000, maxTokens: 1000 })
      render(<TokenCounter />)
      expect(screen.getByTestId('context-ring').getAttribute('data-fraction')).toBe('1.0000')
    })
  })

  describe('the context card', () => {
    const breakdown = {
      at: 1,
      segments: [
        { id: 'messages' as const, label: 'Messages', tokens: 300, color: 'bg-blue-500' },
        { id: 'systemPrompt' as const, label: 'System prompt', tokens: 100, color: 'bg-slate-400' },
      ],
    }

    it('replaces the plain progress block once a request has been measured', () => {
      useContextBreakdown.setState({ byId: { t1: breakdown } })
      mockTokens({ tokenCount: 400, maxTokens: 1000 })
      const onCompact = vi.fn()
      render(<TokenCounter source={{ threadId: 't1' }} onCompact={onCompact} />)
      expect(screen.getByTestId('context-window-card')).toBeTruthy()
      expect(screen.getByTestId('context-bar').querySelector('[data-segment="messages"]')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Compact session' })).toBeTruthy()
      useContextBreakdown.setState({ byId: {} })
    })

    it('is there for a provider with no window size too, without a compaction line', () => {
      useContextBreakdown.setState({ byId: { t1: breakdown } })
      mockTokens({ tokenCount: 400, maxTokens: undefined })
      render(<TokenCounter source={{ threadId: 't1' }} />)
      expect(screen.getByTestId('context-window-card')).toBeTruthy()
      expect(screen.queryByTestId('until-compact')).toBeNull()
      useContextBreakdown.setState({ byId: {} })
    })

    it('leaves the plain layout when nothing has been measured', () => {
      useContextBreakdown.setState({ byId: {} })
      mockTokens({ tokenCount: 400, maxTokens: 1000 })
      render(<TokenCounter source={{ threadId: 't1' }} />)
      expect(screen.queryByTestId('context-window-card')).toBeNull()
    })
  })

  describe('generation speed on hover', () => {
    const two = { inputTokens: 5, requests: 2, cacheReportedRequests: 0, cacheHitRequests: 0 }

    it('shows the latest reply speed, and the average beside the conversation totals', () => {
      mockTokens({ tokenCount: 1400, maxTokens: undefined })
      render(
        <TokenCounter
          speed={{ last: 41.26, average: 38, source: 'measured' }}
          source={{ threadId: 'a', session: two }}
        />
      )
      expect(screen.getByTestId('token-usage-speed').textContent).toContain('41.3 tok/s')
      expect(screen.getByTestId('session-token-usage-speed').textContent).toContain('38.0 tok/s')
    })

    it('marks an estimated speed with ~, and says in a tooltip how it was worked out', () => {
      mockTokens({ tokenCount: 1400, maxTokens: undefined })
      render(<TokenCounter speed={{ last: 120, source: 'estimated' }} />)
      const row = screen.getByTestId('token-usage-speed')
      expect(row.textContent).toContain('~120 tok/s')
      expect(row.querySelector('button')!.getAttribute('aria-label')).toMatch(/Estimated/)
    })

    it('says in a tooltip when the server measured the speed itself', () => {
      mockTokens({ tokenCount: 1400, maxTokens: undefined })
      render(<TokenCounter speed={{ last: 58.2, source: 'server' }} />)
      const row = screen.getByTestId('token-usage-speed')
      expect(row.textContent).not.toContain('~')
      expect(row.querySelector('button')!.getAttribute('aria-label')).toMatch(/server/)
    })

    it('reads the speed off the messages when none is handed in', () => {
      mockTokens({ tokenCount: 1400, maxTokens: 8000 })
      const messages = [
        { id: 'a', role: 'assistant', metadata: { tokenSpeed: { tokenSpeed: 50, tokenCount: 200, durationMs: 4000, source: 'measured' } } },
      ] as never
      render(<TokenCounter messages={messages} />)
      expect(screen.getByTestId('token-usage-speed').textContent).toContain('50.0 tok/s')
    })

    it('says nothing about speed when no reply was long enough to time', () => {
      mockTokens({ tokenCount: 1400, maxTokens: undefined })
      const messages = [
        { id: 'a', role: 'assistant', metadata: { tokenSpeed: { tokenSpeed: 900, tokenCount: 3, durationMs: 4 } } },
      ] as never
      render(<TokenCounter messages={messages} />)
      expect(screen.queryByTestId('token-usage-speed')).toBeNull()
    })
  })

  it('shows Context window header', () => {
    mockTokens({ tokenCount: 500, maxTokens: 1000 })
    render(<TokenCounter />)
    expect(popover().textContent).toContain('Context window')
  })

  it('keeps the remaining tokens one hover away on the plain meter', () => {
    mockTokens({ tokenCount: 300, maxTokens: 1000 })
    render(<TokenCounter />)
    expect(screen.getByTestId('context-used-of').getAttribute('title')).toBe('700 tokens left')
  })

  it('says 0 tokens left when over the limit', () => {
    mockTokens({ tokenCount: 1500, maxTokens: 1000 })
    render(<TokenCounter />)
    expect(screen.getByTestId('context-used-of').getAttribute('title')).toBe('0 tokens left')
  })

  it('shows the overflow note and failing-request numbers when isOverflow', () => {
    mockTokens({ tokenCount: 1200, maxTokens: 1000, isOverflow: true })
    render(<TokenCounter />)
    const tooltipContent = popover()
    expect(tooltipContent.textContent).toMatch(/overflow/i)
    expect(screen.getAllByText('100.0%').length).toBeGreaterThanOrEqual(1)
  })

  it('does not show the overflow note when not overflowing', () => {
    mockTokens({ tokenCount: 500, maxTokens: 1000, isOverflow: false })
    render(<TokenCounter />)
    expect(popover().textContent).not.toMatch(/overflow/i)
  })

  it('accepts className prop', () => {
    mockTokens({ tokenCount: 0, maxTokens: 1000 })
    const { container } = render(<TokenCounter className="custom-class" />)
    const wrapper = container.querySelector('.custom-class')
    expect(wrapper).toBeTruthy()
  })
})
