import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StatStrip, ToolChips, formatCount } from '../SubagentStats'
import { subagentStats } from '@/lib/coworkSubagentStats'
import type { CoworkTurn } from '@/types/coworkSession'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(' ')}` : key,
  }),
}))

const tool = (name: string, toolState: string): CoworkTurn => ({ role: 'tool', name, content: '', toolState }) as CoworkTurn

describe('formatCount', () => {
  it('uses units once a number needs them', () => {
    expect(formatCount(900)).toBe('900')
    expect(formatCount(12000)).toBe('12.0K')
    expect(formatCount(1_300_000)).toBe('1.3M')
  })
})

describe('StatStrip', () => {
  it('labels each value and puts turns in a tooltip, not in the strip', () => {
    const stats = subagentStats(
      {
        startedAt: 0,
        endedAt: 99000,
        status: 'done',
        usage: { prompt_tokens: 12000, completion_tokens: 900, total_tokens: 12900 },
        transcript: [tool('read', 'succeeded'), { role: 'assistant', content: 'x' } as CoworkTurn],
      },
      0
    )
    render(<StatStrip stats={stats} />)
    const strip = screen.getByTestId('subagent-stats')
    expect(strip.querySelector('[data-stat=input] dd')).toHaveTextContent('12.0K')
    expect(strip.querySelector('[data-stat=output] dd')).toHaveTextContent('900')
    expect(strip.querySelector('[data-stat=steps] dd')).toHaveTextContent('1')
    expect(strip.querySelector('[data-stat=steps]')).toHaveAttribute('title', expect.stringContaining('turns=1'))
    expect(strip.textContent).not.toMatch(/\bin\b|\bout\b/)
  })
  it('omits token cells when there are none', () => {
    const stats = subagentStats({ startedAt: 0, status: 'queued' }, 0)
    render(<StatStrip stats={stats} />)
    expect(screen.getByTestId('subagent-stats').querySelector('[data-stat=input]')).toBeNull()
  })
})

describe('ToolChips', () => {
  it('shows chips, a failed one outlined with its count, and one clear status phrase', () => {
    const stats = subagentStats(
      {
        startedAt: 0,
        status: 'running',
        transcript: [tool('bash', 'succeeded'), tool('bash', 'failed'), tool('read', 'running')],
      },
      0
    )
    render(<ToolChips stats={stats} />)
    const chips = screen.getByTestId('subagent-tools')
    expect(chips.querySelector('[data-tool=bash]')).toHaveAttribute('data-failed', 'true')
    expect(chips.querySelector('[data-tool=bash]')).toHaveTextContent('toolChipFailed name=bash count=2 failed=1')
    expect(chips.querySelector('[data-tool=read]')).toHaveTextContent('toolChip name=read count=1')
    expect(screen.getByTestId('subagent-tools-status')).toHaveTextContent('stepsRunning count=1')
    expect(screen.getByTestId('subagent-tools-status')).toHaveTextContent('stepsFailed count=1')
  })
  it('renders nothing with no tool calls', () => {
    const { container } = render(<ToolChips stats={subagentStats({ startedAt: 0, status: 'running' }, 0)} />)
    expect(container).toBeEmptyDOMElement()
  })
})
