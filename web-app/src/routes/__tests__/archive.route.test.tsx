import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { fillServiceHub, renderRoute } from './routeHarness'

describe('Archive route', () => {
  beforeAll(fillServiceHub)
  afterEach(cleanup)

  it('renders its page with the key control and no crash', async () => {
    await renderRoute('/archive')
    expect(
      await screen.findByText('Archive instead of delete', { exact: false })
    ).toBeInTheDocument()
    expect(document.querySelector('[role=alert]')).toBeNull()
  })
})
