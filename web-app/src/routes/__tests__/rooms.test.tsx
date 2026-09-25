/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import React from 'react'
import {
  createFakeApi,
  makeRoom,
  renderWithApi,
} from '@/containers/rooms/__tests__/roomsTestUtils'

const h = vi.hoisted(() => ({ navigate: vi.fn(), params: { roomId: 'r1' } }))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => config,
  Link: ({ children, to, params, ...rest }: any) => (
    <a href={String(to).replace('$roomId', params?.roomId ?? '')} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => h.navigate,
  useParams: () => h.params,
}))
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div data-testid="header-page">{children}</div>,
}))
vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('@/containers/rooms/__tests__/roomsTestUtils')
  return { useTranslation: () => ({ t: u.t }) }
})
vi.mock('@/hooks/useModelProvider', async () => {
  const u = await import('@/containers/rooms/__tests__/roomsTestUtils')
  return { useModelProvider: (sel: any) => sel({ providers: u.testProviders }) }
})

import { Route as ListRoute } from '../rooms/index'
import { Route as DetailRoute } from '../rooms/$roomId'

const List = (ListRoute as any).component as React.ComponentType
const Detail = (DetailRoute as any).component as React.ComponentType

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  title: 'Alpha',
  objective: 'Decide',
  status: 'running',
  mode: 'round-robin',
  createdAt: 1,
  updatedAt: 2,
  participantCount: 2,
  turns: 5,
  ...overrides,
})

describe('rooms list route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders inside the shell layout with an empty state', async () => {
    const { api } = createFakeApi()
    const { container } = renderWithApi(<List />, api)
    const root = container.firstElementChild!
    expect(root).toHaveClass('flex', 'flex-col', 'h-full')
    expect(root.firstElementChild).toHaveAttribute('data-testid', 'header-page')
    expect(root.children[1].className).toContain('h-[calc(100%-var(--ctx-h')
    expect(screen.getByText('No rooms yet')).toBeInTheDocument()
    await waitFor(() => expect(api.loadSummaries).toHaveBeenCalled())
  })

  it('lists rooms with status badges and a link to each', () => {
    const { api } = createFakeApi({
      summaries: [summary(), summary({ id: 'r2', title: 'Beta', status: 'awaiting-user' })] as any,
    })
    renderWithApi(<List />, api)
    const items = screen.getAllByTestId('room-summary')
    expect(items).toHaveLength(2)
    expect(within(items[0]).getByText('Running')).toBeInTheDocument()
    expect(within(items[1]).getByText('Waiting for you')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Beta' })).toHaveAttribute('href', '/rooms/r2')
  })

  it('creates a room and opens it', async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi()
    renderWithApi(<List />, api)
    await user.click(within(screen.getByTestId('header-page')).getByRole('button', { name: 'New room' }))
    const dialog = screen.getByRole('dialog', { name: 'New room' })
    await user.click(within(dialog).getByRole('button', { name: 'Create room' }))
    expect(within(dialog).getByText('Enter a title.')).toBeInTheDocument()
    expect(api.createRoom).not.toHaveBeenCalled()

    await user.type(within(dialog).getByLabelText('Title'), 'Gamma')
    await user.type(within(dialog).getByLabelText('Objective'), 'Pick a name')
    await user.click(within(dialog).getByRole('button', { name: 'Create room' }))
    expect(api.createRoom).toHaveBeenCalledWith({ title: 'Gamma', objective: 'Pick a name' })
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith({ to: '/rooms/$roomId', params: { roomId: 'new1' } })
    )
  })

  it('deletes a room only after confirmation', async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi({ summaries: [summary()] as any })
    renderWithApi(<List />, api)
    await user.click(screen.getByRole('button', { name: 'Delete Alpha' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete room?' })
    expect(api.deleteRoom).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Delete room' }))
    await waitFor(() => expect(api.deleteRoom).toHaveBeenCalledWith('r1'))
    await waitFor(() => expect(api.loadSummaries).toHaveBeenCalledTimes(2))
  })
})

describe('room detail route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads the room and renders usage, transcript, composer, controls and editor', async () => {
    const { api } = createFakeApi({ room: makeRoom({ status: 'paused' }) })
    const { container } = renderWithApi(<Detail />, api)
    await waitFor(() => expect(api.loadRoom).toHaveBeenCalledWith('r1'))
    const root = container.firstElementChild!
    expect(root).toHaveClass('flex', 'flex-col', 'h-full')
    expect(root.firstElementChild).toHaveAttribute('data-testid', 'header-page')
    expect(within(screen.getByTestId('header-page')).getByText('Paused')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Usage' })).toBeInTheDocument()
    expect(screen.getByRole('log', { name: 'Discussion transcript' })).toBeInTheDocument()
    expect(screen.getByLabelText('Message to the room')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Room controls' })).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Room settings' })).toBeInTheDocument()
    // The sidebar's Rooms row is the way back; the page has no back link.
    expect(screen.queryByRole('link', { name: 'All rooms' })).not.toBeInTheDocument()
  })

  it('keeps narrow widths usable: the side panel is full width below lg', () => {
    const { api } = createFakeApi({ room: makeRoom() })
    renderWithApi(<Detail />, api)
    const panel = screen.getByTestId('room-side-panel')
    expect(panel).toHaveClass('w-full', 'lg:w-[370px]')
    expect(panel.className).not.toMatch(/(^|\s)min-w-\[/)
  })

  it('shows not found when the loaded room does not match', async () => {
    const { api } = createFakeApi({ room: makeRoom({ id: 'other' }) })
    renderWithApi(<Detail />, api)
    expect(await screen.findByText('This room could not be found.')).toBeInTheDocument()
  })
})
