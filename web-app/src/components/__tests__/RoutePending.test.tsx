import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

const state = vi.hoisted(() => ({ pathname: '/settings/general', invalidate: vi.fn(), navigate: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: state.pathname } }),
  useRouter: () => ({ invalidate: state.invalidate, navigate: state.navigate }),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { RoutePending, RouteLoadError, RouteNotFound, ROUTE_STALL_MS, routerDefaults } from '../RoutePending'

afterEach(() => vi.useRealTimers())

describe('an address with no page (X-002)', () => {
  it('is the router default and explains, with a way back to settings and home', () => {
    expect(routerDefaults.defaultNotFoundComponent).toBe(RouteNotFound)
    state.pathname = '/settings/appearance'
    render(<RouteNotFound />)
    expect(screen.getByText('common:routeNotFound.title')).toBeInTheDocument()
    fireEvent.click(screen.getByText('common:routeNotFound.settings'))
    expect(state.navigate).toHaveBeenCalledWith({ to: '/settings/general' })
    fireEvent.click(screen.getByText('common:routeNotFound.home'))
    expect(state.navigate).toHaveBeenCalledWith({ to: '/' })
    state.pathname = '/settings/general'
  })

  it('offers only home outside settings', () => {
    state.pathname = '/nowhere'
    render(<RouteNotFound />)
    expect(screen.queryByText('common:routeNotFound.settings')).toBeNull()
    expect(screen.getByText('common:routeNotFound.home')).toBeInTheDocument()
    state.pathname = '/settings/general'
  })
})

describe('route loading (T7-131, T7-134)', () => {
  it('names the page being opened while its code loads', () => {
    render(<RoutePending />)
    expect(screen.getByTestId('route-pending')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('common:settings')).toBeInTheDocument()
  })

  it('offers a reload when the page has not arrived after 8 s', () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    render(<RoutePending />)
    expect(screen.queryByText('common:routeLoading.reload')).toBeNull()
    act(() => vi.advanceTimersByTime(ROUTE_STALL_MS))
    expect(ROUTE_STALL_MS).toBe(8000)
    fireEvent.click(screen.getByText('common:routeLoading.reload'))
    expect(reload).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('shows a failed page load with retry and reload instead of the old page', () => {
    render(<RouteLoadError error={new Error('Failed to fetch dynamically imported module')} reset={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch dynamically imported module')
    fireEvent.click(screen.getByText('common:routeLoading.retry'))
    expect(state.invalidate).toHaveBeenCalled()
  })

  it('makes the router show the pending page quickly', () => {
    expect(routerDefaults.defaultPendingComponent).toBe(RoutePending)
    expect(routerDefaults.defaultErrorComponent).toBe(RouteLoadError)
    expect(routerDefaults.defaultPendingMs).toBeLessThanOrEqual(200)
  })
})
