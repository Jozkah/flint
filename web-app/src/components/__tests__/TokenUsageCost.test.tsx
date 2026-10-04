import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TokenUsageSummary } from '../TokenUsageSummary'
import { finalizeTokenUsage, summarizeUsage } from '@/lib/tokenUsage'
import type { Pricing } from '@/lib/modelPricing'

const priced: Pricing = { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 }
const noCachedPrice: Pricing = { input: 3, output: 15 }

const reply = (over: { cached?: number; write?: number } = {}) =>
  finalizeTokenUsage({
    inputTokens: 100_000,
    outputTokens: 2_000,
    cachedInputTokens: over.cached,
    cacheWriteTokens: over.write,
    requests: 1,
    cacheReportedRequests: over.cached === undefined ? 0 : 1,
    cacheHitRequests: over.cached ? 1 : 0,
  })

const text = (id: string) => screen.getByTestId(id).textContent
const note = (id: string) => screen.getByTestId(id).getAttribute('aria-label')

describe('cache split', () => {
  it('shows cached and new tokens with counts and percentages, bar included', () => {
    render(<TokenUsageSummary usage={reply({ cached: 80_000 })} />)
    expect(screen.getByTestId('token-usage-cache-split-cached').dataset.value).toBe('80000')
    expect(text('token-usage-cache-split-cached')).toContain('80%')
    expect(screen.getByTestId('token-usage-cache-split-new').dataset.value).toBe('20000')
    expect(text('token-usage-cache-split-new')).toContain('20%')
    expect(screen.queryByTestId('token-usage-cache-split-write')).toBeNull()
    expect(screen.getByTestId('token-usage-cache-bar')).toBeTruthy()
  })

  it('adds cache writes as a third segment', () => {
    render(<TokenUsageSummary usage={reply({ cached: 60_000, write: 10_000 })} />)
    expect(screen.getByTestId('token-usage-cache-split-write').dataset.value).toBe('10000')
    expect(screen.getByTestId('token-usage-cache-split-new').dataset.value).toBe('30000')
    expect(screen.getByTestId('token-usage-cache-bar').children).toHaveLength(3)
  })

  it('shows no split when the provider reported no cache info', () => {
    render(<TokenUsageSummary usage={reply()} />)
    expect(screen.queryByTestId('token-usage-cache-split')).toBeNull()
  })
})

describe('cost block', () => {
  it('shows each kind of cost, the total, and the saving', () => {
    render(<TokenUsageSummary usage={reply({ cached: 80_000, write: 5_000 })} pricing={priced} />)
    expect(text('token-usage-cost-cached')).toContain('$0.0240')
    expect(text('token-usage-cost-new')).toContain('$0.0450')
    expect(text('token-usage-cost-write')).toContain('$0.0187')
    expect(text('token-usage-cost-output')).toContain('$0.0300')
    expect(text('token-usage-cost-total')).toContain('$0.1178')
    expect(text('token-usage-cost-saved')).toMatch(/Saved \$0\.2160 \(\d+%\) by caching/)
    expect(screen.getByTestId('token-usage-cost').dataset.cachedFullRate).toBeUndefined()
  })

  it('says the cached input was priced at the full rate when no cached price is set', () => {
    render(<TokenUsageSummary usage={reply({ cached: 80_000 })} pricing={noCachedPrice} />)
    expect(screen.getByTestId('token-usage-cost').dataset.cachedFullRate).toBe('true')
    expect(note('token-usage-cost-note')).toMatch(
      /Cached input priced at the full input rate \(no cached price set\)/
    )
    expect(screen.queryByTestId('token-usage-cost-saved')).toBeNull()
  })

  it('costs a reply without cache info as new input only', () => {
    render(<TokenUsageSummary usage={reply()} pricing={priced} />)
    expect(screen.queryByTestId('token-usage-cost-cached')).toBeNull()
    expect(text('token-usage-cost-new')).toContain('$0.3000')
    expect(text('token-usage-cost-total')).toContain('$0.3300')
    expect(screen.queryByTestId('token-usage-cost-saved')).toBeNull()
  })

  it('adds up the conversation: one request and many', () => {
    const one = reply({ cached: 80_000 })
    const many = summarizeUsage(Array.from({ length: 484 }, () => reply({ cached: 80_000 })))!
    const { rerender } = render(<TokenUsageSummary usage={one} pricing={priced} />)
    expect(screen.queryByTestId('session-token-usage-cost')).toBeNull()
    rerender(<TokenUsageSummary usage={one} session={many} pricing={priced} />)
    const lastTotal = Number(screen.getByTestId('token-usage-cost-total').dataset.value)
    const allTotal = Number(screen.getByTestId('session-token-usage-cost-total').dataset.value)
    expect(allTotal).toBeCloseTo(lastTotal * 484, 8)
    expect(screen.getByTestId('session-token-usage-cost-saved')).toBeTruthy()
  })

  it('charges requests that said nothing about their cache at the full input price', () => {
    const session = summarizeUsage([reply({ cached: 80_000 }), reply()])!
    render(<TokenUsageSummary usage={reply()} session={session} pricing={priced} />)
    // 80k cached at 0.3, 120k new at 3, 4k output at 15.
    expect(Number(screen.getByTestId('session-token-usage-cost-total').dataset.value)).toBeCloseTo(
      (80_000 * 0.3 + 120_000 * 3 + 4_000 * 15) / 1e6,
      10
    )
  })

  it('hides the cost for a free model and offers nothing to set', () => {
    render(<TokenUsageSummary usage={reply({ cached: 80_000 })} pricing={{ input: 0, output: 0 }} />)
    expect(screen.queryByTestId('token-usage-cost')).toBeNull()
    expect(screen.queryByTestId('cost-no-price')).toBeNull()
  })

  it('leaves cost out entirely when no price lookup was made', () => {
    render(<TokenUsageSummary usage={reply({ cached: 80_000 })} />)
    expect(screen.queryByTestId('token-usage-cost')).toBeNull()
    expect(screen.queryByTestId('cost-no-price')).toBeNull()
  })
})

describe('a model with no price', () => {
  it('hides the cost block and offers to set a price, with a tooltip', () => {
    const onSetPrice = vi.fn()
    render(<TokenUsageSummary usage={reply({ cached: 80_000 })} pricing={null} onSetPrice={onSetPrice} />)
    expect(screen.queryByTestId('token-usage-cost')).toBeNull()
    fireEvent.click(screen.getByTestId('cost-set-price'))
    expect(onSetPrice).toHaveBeenCalledOnce()
    expect(note('cost-no-price-note')).toMatch(/provider settings/)
  })

  it('says it in words when there is nowhere to link to', () => {
    render(<TokenUsageSummary usage={reply()} pricing={null} />)
    expect(screen.getByTestId('cost-no-price').textContent).toContain('Set a price to see cost')
    expect(screen.queryByTestId('cost-set-price')).toBeNull()
  })
})
