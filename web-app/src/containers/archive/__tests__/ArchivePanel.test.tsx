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
      item({ archiveId: 'as1', kind: 'assistant', id: 'as1', title: 'An assistant' }),
      item({ archiveId: 'images-s1', kind: 'studio', id: 's1', title: 'A cat picture' }),
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

  it('filters the assistant and Studio kinds, each with its own label', async () => {
    render(<ArchivePanel />)
    await screen.findByText('A thread')
    fireEvent.click(screen.getAllByText('archive:kind.assistant')[0])
    expect(screen.getByText('An assistant')).toBeTruthy()
    expect(screen.queryByText('A cat picture')).toBeNull()
    fireEvent.click(screen.getAllByText('archive:kind.studio')[0])
    expect(screen.getByText('A cat picture')).toBeTruthy()
    expect(screen.queryByText('An assistant')).toBeNull()
  })

  it('restores an item from its context menu', async () => {
    render(<ArchivePanel />)
    await screen.findByText('A thread')
    fireEvent.contextMenu(screen.getAllByTestId('archive-item')[0])
    fireEvent.click(screen.getByRole('menuitem', { name: 'archive:restore' }))
    await waitFor(() => expect(h.restore).toHaveBeenCalledTimes(1))
    expect(h.restore.mock.calls[0][0].archiveId).toBe('a')
  })

  it('asks before deleting forever, then purges that item', async () => {
    render(<ArchivePanel />)
    await screen.findByText('A thread')
    fireEvent.contextMenu(screen.getAllByTestId('archive-item')[0])
    fireEvent.click(screen.getByRole('menuitem', { name: 'archive:deletePermanently' }))
    expect(h.purge).not.toHaveBeenCalled()
    // The dialog's own confirm button.
    fireEvent.click(await screen.findByRole('button', { name: 'archive:deletePermanently' }))
    await waitFor(() => expect(h.purge).toHaveBeenCalledWith('thread', 'a'))
  })

  it('shows why a purge was refused and keeps going', async () => {
    h.purge.mockRejectedValue(new Error('keeps its worktree'))
    render(<ArchivePanel />)
    await screen.findByText('A thread')
    fireEvent.contextMenu(screen.getAllByTestId('archive-item')[0])
    fireEvent.click(screen.getByRole('menuitem', { name: 'archive:deletePermanently' }))
    fireEvent.click(await screen.findByRole('button', { name: 'archive:deletePermanently' }))
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
    fireEvent.click(await screen.findByRole('button', { name: 'archive:deletePermanently' }))
    await waitFor(() => expect(h.empty).toHaveBeenCalledWith(undefined))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('archive:blocked:Work', {
        description: 'unmerged',
      })
    )
  })

  it('opens the menu from the keyboard (Shift+F10 and the menu key) and closes on Escape', async () => {
    render(<ArchivePanel />)
    await screen.findByText('A thread')
    const row = screen.getAllByTestId('archive-item')[0]
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
    const menu = screen.getByRole('menu')
    expect(document.activeElement?.textContent).toBe('archive:preview')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('archive:restore')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('archive:deletePermanently')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.keyDown(row, { key: 'ContextMenu' })
    expect(screen.getByRole('menu')).toBeTruthy()
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

describe('ArchivePanel preview and menu placement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.list.mockResolvedValue([item({})])
  })

  it('previews an item from its eye button, read-only', async () => {
    render(<ArchivePanel />)
    await screen.findByText('A thread')
    fireEvent.click(screen.getByTestId('archive-preview-button'))
    expect(await screen.findByTestId('archive-preview')).toHaveTextContent('A thread')
    expect(h.restore).not.toHaveBeenCalled()
    expect(h.purge).not.toHaveBeenCalled()
  })

  it('has a Preview item in the context menu', async () => {
    render(<ArchivePanel />)
    fireEvent.contextMenu(await screen.findByTestId('archive-item'), { clientX: 5, clientY: 5 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'archive:preview' }))
    expect(await screen.findByTestId('archive-preview')).toBeTruthy()
  })
})
