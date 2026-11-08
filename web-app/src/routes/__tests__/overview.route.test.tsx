import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { fillServiceHub, renderRoute } from './routeHarness'

describe('Overview route', () => {
  beforeAll(fillServiceHub)
  afterEach(cleanup)

  it('renders its page with the key control and no crash', async () => {
    await renderRoute('/overview')
    expect(
      await screen.findByText('Ask something', { exact: false })
    ).toBeInTheDocument()
    expect(document.querySelector('[role=alert]')).toBeNull()
  })
})
