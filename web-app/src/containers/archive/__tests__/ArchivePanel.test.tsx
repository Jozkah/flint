import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o && 'title' in o ? `${k}:${o.title}` : k,
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const h = vi.hoisted(() => ({
  items: [] as unknown[],
  list: vi.fn(),
  purge: vi.fn(),
  empty: vi.fn(),
  setSettings: vi.fn(),
  restore: vi.fn(),
}))

vi.mock('@/lib/archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/archive')>('@/lib/archive')
  return {
    ...actual,
    archiveApi: {
      list: h.list,
      diskUsage: async () => 2048,
      purge: h.purge,
      empty: h.empty,
      getSettings: async () => actual.DEFAULT_ARCHIVE_SETTINGS,
      setSettings: h.setSettings,
    },
  }
})
vi.mock('@/lib/archiveRestore', () => ({ restoreArchived: h.restore }))

import { ArchivePanel } from '../ArchivePanel'
import { toast } from 'sonner'

const item = (over: Record<string, unknown>) => ({
  archiveId: 'a',
  kind: 'thread',
  id: 'a',
  title: 'A thread',
  archivedAt: 1_700_000_000_000,
  origin: 'threads/a',
  storage: 'dir',
  sizeBytes: 1536,
  ...over,
})

describe('ArchivePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.items = [
      item({}),
      item({ archiveId: 'r1', kind: 'room', id: 'r1', title: 'A room' }),
    ]
    h.list.mockImplementation(async () => h.items)
    h.purge.mockResolvedValue(undefined)
    h.empty.mockResolvedValue({ purged: 2, blocked: [] })
    h.setSettings.mockImplementation(async (s: unknown) => s)
  })

  it('lists archived items with their size and the disk usage', async () => {
    render(<ArchivePanel />)
    expect(await screen.findByText('A thread')).toBeTruthy()
    expect(screen.getByText('A room')).toBeTruthy()
    expect(screen.getByTestId('archive-usage').textContent).toContain('archive:usage')
  })

  it('filters by kind', async () => {
    render(<ArchivePanel />)
    await screen.findByText('A thread')
    fireEvent.click(screen.getAllByText('archive:kind.room')[0])
    expect(screen.queryByText('A thread')).toBeNull()
    expect(screen.getByText('A room')).toBeTruthy()
  })

  it('restores an item', async () => {
    render(<ArchivePanel />)
    await screen.findByText('A thread')
    fireEvent.click(screen.getAllByText('archive:restore')[0])
    await waitFor(() => expect(h.restore).toHaveBeenCalledTimes(1))
    expect(h.restore.mock.calls[0][0].archiveId).toBe('a')
  })

  it('asks before deleting forever, then purges that item', async () => {
    render(<ArchivePanel />)
    await screen.findByText('A thread')
    fireEvent.click(screen.getAllByText('archive:deleteForever')[0])
    expect(h.purge).not.toHaveBeenCalled()
    // The dialog's own confirm button.
    const confirm = await screen.findAllByText('archive:deleteForever')
    fireEvent.click(confirm[confirm.length - 1])
    await waitFor(() => expect(h.purge).toHaveBeenCalledWith('thread', 'a'))
  })

  it('shows why a purge was refused and keeps going', async () => {
    h.purge.mockRejectedValue(new Error('keeps its worktree'))
    render(<ArchivePanel />)
    await screen.findByText('A thread')
    fireEvent.click(screen.getAllByText('archive:deleteForever')[0])
    const confirm = await screen.findAllByText('archive:deleteForever')
    fireEvent.click(confirm[confirm.length - 1])
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })

  it('empties the archive after a confirmation and reports what a guard kept', async () => {
    h.empty.mockResolvedValue({
      purged: 1,
      blocked: [{ kind: 'cowork', archiveId: 'c', title: 'Work', reason: 'unmerged' }],
    })
    render(<ArchivePanel />)
    await screen.findByText('A thread')
    fireEvent.click(screen.getByText('archive:empty'))
    expect(h.empty).not.toHaveBeenCalled()
    const confirm = await screen.findAllByText('archive:deleteForever')
    fireEvent.click(confirm[confirm.length - 1])
    await waitFor(() => expect(h.empty).toHaveBeenCalledWith(undefined))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('archive:blocked:Work', {
        description: 'unmerged',
      })
    )
  })

  it('saves the settings', async () => {
    render(<ArchivePanel />)
    await screen.findByText('A thread')
    fireEvent.click(screen.getByRole('switch', { name: 'archive:enabled' }))
    await waitFor(() =>
      expect(h.setSettings).toHaveBeenCalledWith({
        enabled: false,
        autoDeleteDays: 30,
        autoArchiveThreadDays: 0,
      })
    )
  })

  it('says so when the archive is empty', async () => {
    h.items = []
    render(<ArchivePanel />)
    expect(await screen.findByText('archive:none')).toBeTruthy()
  })
})
