import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { a11yViolations, fillServiceHub, renderRoute } from './routeHarness'

// Baseline: the violation count axe reports for each route today. The test
// passes while a route stays at or under its recorded count and fails when a
// change adds one (today each route carries one shared-shell `list` finding).
const BASELINE: Record<string, number> = {
  '/archive': 1,
  '/campaigns': 1,
  '/logs': 1,
}

describe('route accessibility baseline', () => {
  beforeAll(() => fillServiceHub())
  afterEach(() => cleanup())

  it.each(Object.keys(BASELINE))('%s adds no new axe violations', async (path) => {
    const { container } = await renderRoute(path)
    const found = await a11yViolations(container)
    const count = found.reduce((n, v) => n + v.nodes, 0)
    expect(count, JSON.stringify(found)).toBeLessThanOrEqual(BASELINE[path])
  })
})
