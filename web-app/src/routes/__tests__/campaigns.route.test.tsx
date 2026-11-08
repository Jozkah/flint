import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { fillServiceHub, renderRoute } from './routeHarness'

describe('Campaigns route', () => {
  beforeAll(fillServiceHub)
  afterEach(cleanup)

  it('renders its page with the key control and no crash', async () => {
    await renderRoute('/campaigns')
    expect(
      await screen.findByText('Start a campaign', { exact: false })
    ).toBeInTheDocument()
    expect(document.querySelector('[role=alert]')).toBeNull()
  })
})
