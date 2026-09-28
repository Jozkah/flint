import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CacheReuseBadge } from '@/components/CacheReuseBadge'
import { TokenUsageBreakdown } from '@/components/TokenUsageBreakdown'
import { TooltipProvider } from '@/components/ui/tooltip'
import { finalizeTokenUsage, summarizeUsage } from '@/lib/tokenUsage'

const usage = (input: number, cached?: number, output = 10) =>
  finalizeTokenUsage({
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    cacheSource: cached === undefined ? undefined : 'openai-chat',
    requests: 1,
    cacheReportedRequests: cached === undefined ? 0 : 1,
    cacheHitRequests: cached !== undefined && cached > 0 ? 1 : 0,
  })

describe('CacheReuseBadge', () => {
  it('flags reuse in words, with the share and the exact values', () => {
    render(<CacheReuseBadge usage={usage(1000, 900)} />)
    const badge = screen.getByTestId('cache-status')
    expect(badge.dataset.cacheStatus).toBe('reused')
    expect(badge).toHaveTextContent('90% input cached')
    // Not colour alone: the label names the state and every number.
    expect(badge.getAttribute('aria-label')).toBe(
      'Cache reused. Input 1,000, Cached 900, Uncached 100, Output 10, Total 1,010.'
    )
    expect(badge.getAttribute('title')).toBe(badge.getAttribute('aria-label'))
  })

  it('says "No cached input" for an explicit zero', () => {
    render(<CacheReuseBadge usage={usage(1000, 0)} />)
    expect(screen.getByTestId('cache-status')).toHaveTextContent('No cached input')
  })

  it('says "Not reported" for an absent field, and hides in compact rows', () => {
    const { rerender } = render(<CacheReuseBadge usage={usage(1000)} />)
    expect(screen.getByTestId('cache-status')).toHaveTextContent('Not reported')
    rerender(<CacheReuseBadge usage={usage(1000)} hideUnreported />)
    expect(screen.queryByTestId('cache-status')).toBeNull()
  })

  it('on a session, counts requests apart from tokens', () => {
    const session = summarizeUsage([usage(1000, 900), usage(1000)])!
    render(<CacheReuseBadge usage={session} />)
    const badge = screen.getByTestId('cache-status')
    expect(badge.dataset.cacheStatus).toBe('reused')
    expect(badge.getAttribute('aria-label')).toContain('Cache reused on 1 of 2 requests.')
    expect(badge.getAttribute('aria-label')).toContain('Not every request reported')
  })
})

describe('TokenUsageBreakdown cache status row', () => {
  const renderIn = (u: ReturnType<typeof usage>) =>
    render(
      <TooltipProvider>
        <TokenUsageBreakdown usage={u} />
      </TooltipProvider>
    )

  it('shows the status, cached and uncached for partial reuse', () => {
    renderIn(usage(6379, 6342))
    expect(screen.getByTestId('token-usage-cache-status').dataset.cacheStatus).toBe('reused')
    expect(screen.getByTestId('token-usage-cached').dataset.value).toBe('6342')
    expect(screen.getByTestId('token-usage-uncached').dataset.value).toBe('37')
  })

  it('distinguishes an explicit zero from not reported', () => {
    const { unmount } = renderIn(usage(100, 0))
    expect(screen.getByTestId('token-usage-cache-status')).toHaveTextContent('No cached input')
    unmount()
    renderIn(usage(100))
    expect(screen.getByTestId('token-usage-cache-status')).toHaveTextContent('Not reported')
    expect(screen.getByTestId('token-usage-cache-unreported')).toHaveTextContent('Not reported')
  })

  it('names how many requests reused the cache on a session total', () => {
    renderIn(summarizeUsage([usage(10, 5), usage(10, 0), usage(10)])!)
    const row = screen.getByTestId('token-usage-cache-requests')
    expect(row).toHaveTextContent('3 requests · cache reused on 1 · 1 did not report the cache')
  })
})
