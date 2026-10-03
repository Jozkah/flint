import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ContextWindowCard } from '../ContextWindowCard'
import type { ContextSegment } from '@/lib/contextBreakdown'

const segments: ContextSegment[] = [
  { id: 'messages', label: 'Messages', tokens: 5000, color: 'bg-blue-500' },
  {
    id: 'mcpTools',
    label: 'MCP tools',
    tokens: 3000,
    color: 'bg-emerald-500',
    children: [
      { label: 'notion', tokens: 2000 },
      { label: 'ida', tokens: 1000 },
    ],
  },
  { id: 'systemPrompt', label: 'System prompt', tokens: 2000, color: 'bg-slate-400' },
]

const local = {
  segments,
  usedTokens: 10000,
  windowTokens: 100000,
  autoCompactOn: true,
  autoCompactBuffer: 20000,
}

describe('ContextWindowCard', () => {
  it('shows the total, a bar with one colour per kind, and what is left before compaction', () => {
    render(<ContextWindowCard {...local} />)
    expect(screen.getByText(/10\.0K \/ 100\.0K \(10%\)/)).toBeTruthy()
    const bar = screen.getByTestId('context-bar')
    expect(bar.querySelector('[data-segment="messages"]')?.className).toContain('bg-blue-500')
    expect(bar.querySelector('[data-segment="mcpTools"]')?.className).toContain('bg-emerald-500')
    expect(bar.querySelector('[data-segment="buffer"]')).toBeTruthy()
    expect(screen.getByTestId('until-compact').textContent).toContain('70.0K until auto-compact')
    // Collapsed: no legend yet.
    expect(screen.queryByTestId('context-legend')).toBeNull()
  })

  it('lists every kind with its share when expanded, then the parts of a kind when that opens', async () => {
    render(<ContextWindowCard {...local} />)
    await userEvent.click(screen.getByRole('button', { name: /context window/i }))
    const legend = screen.getByTestId('context-legend')
    expect(legend.textContent).toContain('Messages')
    expect(legend.textContent).toContain('5.0%')
    expect(legend.textContent).toContain('Autocompact buffer')
    expect(legend.textContent).toContain('Free space')
    expect(screen.queryByText('notion')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /MCP tools/ }))
    expect(screen.getByText('notion')).toBeTruthy()
    expect(screen.getByText('ida')).toBeTruthy()
  })

  it('offers Compact session only when it can, and calls it', async () => {
    const onCompact = vi.fn()
    const { rerender } = render(<ContextWindowCard {...local} autoCompactOn={undefined} />)
    expect(screen.queryByRole('button', { name: 'Compact session' })).toBeNull()
    rerender(<ContextWindowCard {...local} onCompact={onCompact} />)
    await userEvent.click(screen.getByRole('button', { name: 'Compact session' }))
    expect(onCompact).toHaveBeenCalledTimes(1)
  })

  it('works with no window size: shares of what is used, no free space, no compaction line', () => {
    render(<ContextWindowCard segments={segments} usedTokens={10000} defaultExpanded />)
    expect(screen.getByText('10.0K tokens')).toBeTruthy()
    expect(screen.queryByTestId('until-compact')).toBeNull()
    const legend = screen.getByTestId('context-legend')
    expect(legend.textContent).not.toContain('Free space')
    expect(legend.textContent).toContain('50.0%')
  })

  it('says so when auto-compact is off', () => {
    render(<ContextWindowCard {...local} autoCompactOn={false} onCompact={() => {}} />)
    expect(screen.getByTestId('until-compact').textContent).toBe('Auto-compact is off')
  })

  describe('how full the window is', () => {
    const width = (el: Element | null) =>
      Number.parseFloat((el as HTMLElement).style.width)

    it('scales every kind to the window, so the unused part is what is left grey', () => {
      render(<ContextWindowCard {...local} />)
      const bar = screen.getByTestId('context-bar')
      const used = Array.from(bar.querySelectorAll('[data-segment]'))
        .filter((el) => el.getAttribute('data-segment') !== 'buffer')
        .reduce((sum, el) => sum + width(el), 0)
      // 10K used of a 100K window: a tenth of the bar, not all of it.
      expect(used).toBeCloseTo(10, 1)
      expect(used).toBeLessThan(100)
    })

    it('does not read as full when the window is not known, and says why', () => {
      render(<ContextWindowCard segments={segments} usedTokens={10000} />)
      expect(screen.getByTestId('window-unknown').textContent).toContain(
        'not how full it is'
      )
      expect(
        (screen.getByTestId('context-bar') as HTMLElement).style.maskImage
      ).toContain('linear-gradient')
    })

    it('says nothing about an unknown window when it is known', () => {
      render(<ContextWindowCard {...local} />)
      expect(screen.queryByTestId('window-unknown')).toBeNull()
      expect((screen.getByTestId('context-bar') as HTMLElement).style.maskImage).toBeFalsy()
    })
  })

  describe('how old the figures are', () => {
    const now = Date.UTC(2026, 9, 3, 12, 0, 0)

    it('says so for a request sent hours ago', () => {
      render(<ContextWindowCard {...local} updatedAt={now - 2 * 3_600_000} now={now} />)
      expect(screen.getByTestId('context-age').textContent).toBe(
        'Last updated 2 hours ago. Send a message to refresh.'
      )
    })

    it('counts minutes and days too', () => {
      const { rerender } = render(
        <ContextWindowCard {...local} updatedAt={now - 5 * 60_000} now={now} />
      )
      expect(screen.getByTestId('context-age').textContent).toContain('5 minutes ago')
      rerender(<ContextWindowCard {...local} updatedAt={now - 3 * 86_400_000} now={now} />)
      expect(screen.getByTestId('context-age').textContent).toContain('3 days ago')
    })

    it('stays quiet for a request that has just been sent, or one with no time', () => {
      const { rerender } = render(
        <ContextWindowCard {...local} updatedAt={now - 20_000} now={now} />
      )
      expect(screen.queryByTestId('context-age')).toBeNull()
      rerender(<ContextWindowCard {...local} />)
      expect(screen.queryByTestId('context-age')).toBeNull()
    })
  })
})
