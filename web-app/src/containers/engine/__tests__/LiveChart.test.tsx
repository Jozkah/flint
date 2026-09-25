import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { LiveChart, chartPoints } from '../LiveChart'
import { bucketCounts } from '@/stores/engine-activity-store'

describe('chartPoints', () => {
  it('draws to scale from a zero baseline', () => {
    const pts = chartPoints([0, 10, 20])
    // Same x step between points, last point at the plot end.
    expect(pts[1][0] - pts[0][0]).toBeCloseTo(pts[2][0] - pts[1][0])
    expect(pts[2][0]).toBe(192)
    // Zero sits on the bottom edge; heights above it are proportional.
    expect(pts[0][1]).toBe(60)
    const h1 = 60 - pts[1][1]
    const h2 = 60 - pts[2][1]
    expect(h2 / h1).toBeCloseTo(2)
  })

  it('keeps the peak below the top edge', () => {
    const [, peak] = chartPoints([1, 5])
    expect(peak[1]).toBeGreaterThan(0)
  })
})

describe('LiveChart', () => {
  it('puts the dot exactly on the last point of the line', () => {
    const series = [3, 8, 4, 12]
    const { container } = render(<LiveChart series={series} label="calls / min" />)
    const dot = container.querySelector(
      '[data-slot=live-chart-dot]'
    ) as HTMLElement
    const last = chartPoints(series)[series.length - 1]
    expect(dot.style.left).toBe(`${(last[0] / 200) * 100}%`)
    expect(dot.style.top).toBe(`${(last[1] / 60) * 100}%`)
    // The line path ends at the same coordinates.
    const line = container.querySelectorAll('path')[1].getAttribute('d')!
    expect(line.endsWith(`${last[0].toFixed(1)},${last[1].toFixed(1)}`)).toBe(
      true
    )
  })

  it('shows the current value, peak and average', () => {
    render(<LiveChart series={[2, 4, 6]} label="calls / min" />)
    const chart = screen.getByRole('img')
    expect(chart).toHaveTextContent('6')
    expect(chart).toHaveTextContent('peak 6')
    expect(chart).toHaveTextContent('avg 4')
  })

  it('hides the dot and figures when the source is off', () => {
    const { container } = render(
      <LiveChart series={[1, 2]} off label="calls / min" />
    )
    expect(container.querySelector('[data-slot=live-chart-dot]')).toBeNull()
    expect(screen.getByRole('img')).toHaveTextContent('—')
  })
})

describe('bucketCounts', () => {
  it('counts samples into equal buckets, oldest first', () => {
    const now = 10 * 60_000
    const samples = [
      { at: now - 30_000 },
      { at: now - 45_000 },
      { at: now - 3 * 60_000 + 1 },
      { at: now - 20 * 60_000 },
    ]
    expect(bucketCounts(samples, 3, 60_000, now)).toEqual([1, 0, 2])
  })
})
