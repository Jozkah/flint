/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { fillServiceHub, renderRoute } from './routeHarness'
import { getServiceHub } from '@/hooks/useServiceHub'

const startLocalApiServer = vi.hoisted(() => vi.fn())
vi.mock('@/lib/localApiServer', () => ({ startLocalApiServer }))

// With only remote providers there is no local model to load. That is not a
// reason to refuse the server: it serves the registered remote providers.
describe('Local API Server with no local model', () => {
  beforeAll(fillServiceHub)
  afterEach(cleanup)

  it('starts the server instead of failing on the missing model', async () => {
    startLocalApiServer.mockResolvedValue(1337)
    const app = getServiceHub().app() as any
    app.getServerStatus = vi.fn().mockResolvedValue(false)
    await renderRoute('/settings/local-api-server')
    const start = (await screen.findAllByRole('button')).find((b) =>
      /start/i.test(b.textContent ?? '')
    )
    expect(start).toBeTruthy()
    fireEvent.click(start!)
    await waitFor(() => expect(startLocalApiServer).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    })
  })
})
