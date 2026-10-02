import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Shell } from '../shell/Shell'
import { RemoteCallError } from '../api/client'
import { resetApp, useFixtures } from './helpers'
import { hashToRoute, routeToHash } from '../state/router'

const T = { timeout: 3000 }
const touch = { touches: [{ clientX: 120, clientY: 300 }], changedTouches: [{ clientX: 120, clientY: 300 }] }
const items = [
  { key: 'thread:t1', kind: 'thread', title: 'Old chat', archivedAt: Date.now() - 3600_000, sizeBytes: 2048 },
  { key: 'room:r1', kind: 'room', title: 'Big room', archivedAt: Date.now() - 7200_000, sizeBytes: 10 },
  { key: 'studio:images-1-j', kind: 'studio', title: 'Cat picture', archivedAt: Date.now() - 9500_000, sizeBytes: 1 },
  { key: 'assistant:a1', kind: 'assistant', title: 'Helper', archivedAt: Date.now() - 9600_000, sizeBytes: 1 },
  { key: 'cowork:c1', kind: 'cowork', title: 'Work session', archivedAt: Date.now() - 9000_000, sizeBytes: 99 },
]

describe('phone Archive', () => {
  let client: ReturnType<typeof useFixtures>
  beforeEach(() => {
    client = useFixtures({
      'archive.list': { items, retentionDays: 30 },
      'archive.restore': { ok: true },
      'archive.purge': { ok: true },
      'archive.empty': { purged: 3, blocked: [] },
    })
    resetApp({ name: 'archive' })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('lists the items with the retention note and filters by kind', async () => {
    render(<Shell />)
    expect(await screen.findByText('Old chat', {}, T)).toBeInTheDocument()
    expect(screen.getByText('Big room')).toBeInTheDocument()
    expect(screen.getByTestId('archive-retention')).toHaveTextContent('deleted for good after 30 days')
    fireEvent.click(screen.getByRole('button', { name: 'Rooms' }))
    expect(screen.queryByText('Old chat')).not.toBeInTheDocument()
    expect(screen.getByText('Big room')).toBeInTheDocument()
  })

  it('filters Studio results and assistants', async () => {
    render(<Shell />)
    await screen.findByText('Old chat', {}, T)
    fireEvent.click(screen.getByRole('button', { name: 'Studio' }))
    expect(screen.getByText('Cat picture')).toBeInTheDocument()
    expect(screen.queryByText('Helper')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Assistants' }))
    expect(screen.getByText('Helper')).toBeInTheDocument()
  })

  it('says items stay when retention is off', async () => {
    client = useFixtures({ 'archive.list': { items: [], retentionDays: 0 } })
    resetApp({ name: 'archive' })
    render(<Shell />)
    expect(await screen.findByText('Nothing in the archive.', {}, T)).toBeInTheDocument()
    expect(screen.getByTestId('archive-retention')).toHaveTextContent('stay until you delete them')
  })

  it('a long-press opens the menu, and Restore restores that item', async () => {
    render(<Shell />)
    const row = (await screen.findByText('Old chat', {}, T)).closest('button')!
    vi.useFakeTimers()
    fireEvent.touchStart(row, touch)
    act(() => {
      vi.advanceTimersByTime(600)
    })
    vi.useRealTimers()
    fireEvent.click(await screen.findByRole('button', { name: /Restore/ }, T))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('archive.restore', { key: 'thread:t1' }))
  })

  it('a short touch does not fire the long-press', async () => {
    render(<Shell />)
    const row = (await screen.findByText('Old chat', {}, T)).closest('button')!
    vi.useFakeTimers()
    fireEvent.touchStart(row, touch)
    fireEvent.touchEnd(row, touch)
    act(() => {
      vi.advanceTimersByTime(900)
    })
    vi.useRealTimers()
    expect(screen.queryByRole('button', { name: /Delete permanently/ })).not.toBeInTheDocument()
  })

  it('Delete permanently asks first, and purges only when confirmed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<Shell />)
    const row = (await screen.findByText('Big room', {}, T)).closest('button')!
    fireEvent.contextMenu(row)
    fireEvent.click(await screen.findByRole('button', { name: /Delete permanently/ }, T))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(client.rpc).not.toHaveBeenCalledWith('archive.purge', expect.anything())
    fireEvent.contextMenu(row)
    fireEvent.click(await screen.findByRole('button', { name: /Delete permanently/ }, T))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('archive.purge', { key: 'room:r1' }))
  })

  it('shows the guard reason when a purge is refused', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    client.rpc.mockImplementation(async (method: string) => {
      if (method === 'archive.list') return { items, retentionDays: 30 }
      if (method === 'archive.purge') throw new RemoteCallError('refused', '"Work session" keeps its worktree: unmerged work')
      throw new RemoteCallError('not_implemented', method)
    })
    render(<Shell />)
    const row = (await screen.findByText('Work session', {}, T)).closest('button')!
    fireEvent.contextMenu(row)
    fireEvent.click(await screen.findByRole('button', { name: /Delete permanently/ }, T))
    expect(await screen.findByText(/keeps its worktree/, {}, T)).toBeInTheDocument()
  })

  it('empties the archive after a confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<Shell />)
    await screen.findByText('Old chat', {}, T)
    fireEvent.click(screen.getByRole('button', { name: 'Empty archive' }))
    expect(client.rpc).not.toHaveBeenCalledWith('archive.empty', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Empty archive' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('archive.empty', {}))
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('tells an older computer apart from an empty archive', async () => {
    client = useFixtures({})
    resetApp({ name: 'archive' })
    render(<Shell />)
    expect(await screen.findByText(/not available from phones yet/, {}, T)).toBeInTheDocument()
  })

  it('has a nav entry and a route', async () => {
    expect(hashToRoute('#/archive')).toEqual({ name: 'archive' })
    expect(routeToHash({ name: 'archive' })).toBe('#/archive')
  })
})
