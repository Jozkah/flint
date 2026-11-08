import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { fillServiceHub, renderRoute } from './routeHarness'

describe('Studio route', () => {
  beforeAll(fillServiceHub)
  afterEach(cleanup)

  it('renders its page with the key control and no crash', async () => {
    await renderRoute('/studio')
    expect(
      await screen.findByText('Create images and video locally on this computer', { exact: false })
    ).toBeInTheDocument()
  })
})
