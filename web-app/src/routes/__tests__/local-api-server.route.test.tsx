import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { fillServiceHub, renderRoute } from './routeHarness'

describe('Settings/Local API Server route', () => {
  beforeAll(fillServiceHub)
  afterEach(cleanup)

  it('renders its page with the key control and no crash', async () => {
    await renderRoute('/settings/local-api-server')
    expect(
      (await screen.findAllByText('OpenAI-compatible', { exact: false })).length
    ).toBeGreaterThan(0)
    expect(document.querySelector('[role=alert]')).toBeNull()
  })
})
