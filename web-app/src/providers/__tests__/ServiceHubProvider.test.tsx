import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'

const h = vi.hoisted(() => ({
  init: vi.fn(),
  store: vi.fn(),
}))

vi.mock('@/services', () => ({ initializeServiceHub: h.init }))
vi.mock('@/hooks/useServiceHub', () => ({ initializeServiceHubStore: h.store }))
const hydrate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/hydrateStores', () => ({ hydrateBackendStores: hydrate }))
vi.mock('@/lib/migrateLocalStorageSettings', () => ({
  migrateLocalStorageToBackend: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/soloFlag', () => ({ isChatWindow: () => false }))

import { ServiceHubProvider, prestartServiceHub } from '../ServiceHubProvider'

describe('ServiceHubProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hydrate.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('takes over a hub prestarted by main.tsx instead of starting another', async () => {
    const hub = { id: 'early' }
    h.init.mockResolvedValue(hub)
    const early = prestartServiceHub()
    expect(prestartServiceHub()).toBe(early)
    render(
      <ServiceHubProvider>
        <div data-testid="child" />
      </ServiceHubProvider>
    )
    expect(await screen.findByTestId('child')).toBeInTheDocument()
    expect(h.init).toHaveBeenCalledTimes(1)
    expect(h.store).toHaveBeenCalledWith(hub)
    // Taken once: a later mount (a reload of the provider) starts its own.
    render(
      <ServiceHubProvider>
        <div data-testid="child2" />
      </ServiceHubProvider>
    )
    expect(await screen.findByTestId('child2')).toBeInTheDocument()
    expect(h.init).toHaveBeenCalledTimes(2)
  })

  it('tries again after one failed module fetch and then renders the app', async () => {
    h.init
      .mockRejectedValueOnce(
        new Error('Failed to fetch dynamically imported module: x')
      )
      .mockResolvedValueOnce({})
    render(
      <ServiceHubProvider>
        <div data-testid="child" />
      </ServiceHubProvider>
    )
    expect(
      await screen.findByTestId('child', {}, { timeout: 5000 })
    ).toBeInTheDocument()
    expect(h.init).toHaveBeenCalledTimes(2)
  })

  it('shows what failed, with Reload, instead of an app that throws everywhere', async () => {
    h.init.mockRejectedValue(new Error('boom'))
    render(
      <ServiceHubProvider>
        <div data-testid="child" />
      </ServiceHubProvider>
    )
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument(), {
      timeout: 8000,
    })
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.queryByTestId('child')).toBeNull()
    expect(h.init).toHaveBeenCalledTimes(3)
  }, 12000)

  it('does not render the app on defaults when saved settings fail to load, and retries', async () => {
    h.init.mockResolvedValue({})
    hydrate.mockRejectedValueOnce(new Error('Could not read saved settings: k'))
    render(
      <ServiceHubProvider>
        <div data-testid="child" />
      </ServiceHubProvider>
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('saved settings')
    expect(screen.queryByTestId('child')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('child')).toBeInTheDocument()
    expect(hydrate).toHaveBeenCalledTimes(2)
  })
})
