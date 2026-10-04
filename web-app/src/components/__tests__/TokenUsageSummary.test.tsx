import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TokenUsageSummary } from '../TokenUsageSummary'
import { ContextWindowCard } from '../ContextWindowCard'
import {
  combineTokenUsage,
  finalizeTokenUsage,
  summarizeUsage,
} from '@/lib/tokenUsage'

const reply = (cached?: number) =>
  finalizeTokenUsage({
    inputTokens: 1000,
    outputTokens: 100,
    cachedInputTokens: cached,
    requests: 1,
    cacheReportedRequests: cached === undefined ? 0 : 1,
    cacheHitRequests: cached ? 1 : 0,
  })

const note = (id: string) => screen.getByTestId(id).getAttribute('aria-label')

describe('TokenUsageSummary, conversation group', () => {
  it('shows the aggregate cached share, never the bare word', () => {
    const session = summarizeUsage([reply(900), reply(800), reply(700)])!
    render(<TokenUsageSummary usage={reply(900)} session={session} />)
    expect(screen.getByTestId('session-token-usage-cache-status').textContent).toBe('80% cached')
    // All three reported: nothing to qualify.
    expect(note('session-token-usage-cache-note')).not.toMatch(/Only/)
  })

  it('says how many requests reported when not all did, and the share is of those', () => {
    const session = summarizeUsage([reply(900), reply(), reply(700), reply()])!
    render(<TokenUsageSummary usage={reply(900)} session={session} />)
    expect(screen.getByTestId('session-token-usage-cache-status').textContent).toBe('80% cached')
    expect(note('session-token-usage-cache-note')).toMatch(/Only 2 of 4 requests reported cache info/)
  })

  it('shows a dash with a tooltip when no request reported cache info', () => {
    const session = summarizeUsage([reply(), reply()])!
    render(<TokenUsageSummary usage={reply()} session={session} />)
    const status = screen.getByTestId('session-token-usage-cache-status')
    expect(status.textContent).toBe('-')
    expect(status.textContent).not.toMatch(/cached/)
    expect(note('session-token-usage-cache-note')).toMatch(/No request reported/)
  })

  it('never prints a bare "cached" for an old aggregate whose share is unknown', () => {
    const session = finalizeTokenUsage({
      inputTokens: 5000,
      outputTokens: 50,
      requests: 5,
      cacheReportedRequests: 2,
      cacheHitRequests: 2,
    })
    render(<TokenUsageSummary usage={reply(900)} session={session} />)
    expect(screen.getByTestId('session-token-usage-cache-status').textContent).toBe('-')
  })

  it('labels the sums as all requests and keeps Total equal to input plus output', () => {
    const a = finalizeTokenUsage({ inputTokens: 100, outputTokens: 5, totalTokens: 999, requests: 1 })
    const b = finalizeTokenUsage({ inputTokens: 200, outputTokens: 7, totalTokens: 1, requests: 1 })
    render(<TokenUsageSummary usage={a} session={combineTokenUsage(a, b)} />)
    expect(screen.getByText(/All requests \(2\)/)).toBeTruthy()
    expect(screen.getByTestId('session-token-usage-total').getAttribute('data-value')).toBe('312')
    // A provider total that disagrees with its parts does not reach the popup.
    expect(screen.getByTestId('token-usage-total').getAttribute('data-value')).toBe('105')
  })

  it('says in the speed tooltip how many replies the average is over', () => {
    const session = summarizeUsage([reply(900), reply(800)])!
    render(
      <TokenUsageSummary
        usage={reply(900)}
        session={session}
        speed={{ last: 63.3, average: 58, samples: 1, source: 'measured' }}
      />
    )
    const row = screen.getByTestId('session-token-usage-speed')
    expect(row.getAttribute('data-samples')).toBe('1')
    expect(note('session-token-usage-speed-note')).toMatch(/1 reply of 2 requests/)
  })

  it('does not double count cached input in the last reply', () => {
    render(<TokenUsageSummary usage={reply(900)} />)
    const input = screen.getByTestId('token-usage-input')
    expect(Number(input.dataset.cached) + Number(input.dataset.uncached)).toBe(
      Number(input.dataset.value)
    )
  })
})

describe('ContextWindowCard estimate note', () => {
  it('explains in a tooltip what is estimated', () => {
    render(
      <ContextWindowCard
        segments={[{ id: 'messages', label: 'Messages', tokens: 300, color: 'bg-blue-500' }]}
        usedTokens={300}
        windowTokens={1000}
      />
    )
    expect(screen.getByText('Estimated')).toBeTruthy()
    expect(note('context-estimated-note')).toMatch(/4 characters per token/)
  })
})
