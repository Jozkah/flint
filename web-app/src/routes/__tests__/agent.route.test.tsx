import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { fillServiceHub, renderRoute } from './routeHarness'

describe('Settings/Agent route', () => {
  beforeAll(fillServiceHub)
  afterEach(cleanup)

  it('renders its page with the key control and no crash', async () => {
    await renderRoute('/settings/agent')
    expect(
      await screen.findByText('Files, shell and network access', { exact: false })
    ).toBeInTheDocument()
    expect(document.querySelector('[role=alert]')).toBeNull()
  })
})
