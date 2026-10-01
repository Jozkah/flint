/**
 * #78: the per-item delete dialogs opened with focus on the destructive button
 * (and four also deleted on an Enter keydown there), so one reflexive Enter
 * right after opening deleted the item. They must open on Cancel.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: (sel: (s: { threads: Record<string, unknown> }) => unknown) =>
    sel({ threads: {} }),
}))
const deleteFolderWithThreads = vi.fn(async () => {})
vi.mock('@/hooks/useThreadManagement', () => ({
  useThreadManagement: () => ({ deleteFolderWithThreads }),
}))

import { DeleteThreadDialog } from '../DeleteThreadDialog'
import { DeleteProjectDialog } from '../DeleteProjectDialog'
import { DeleteAssistantDialog } from '../DeleteAssistantDialog'
import { DeleteMessageDialog } from '../DeleteMessageDialog'
import DeleteMCPServerConfirm from '../DeleteMCPServerConfirm'

type Case = {
  name: string
  cancel: string
  open: (onDelete: () => void) => void
  deleted: (onDelete: ReturnType<typeof vi.fn>) => boolean
}

const cases: Case[] = [
  {
    name: 'DeleteThreadDialog',
    cancel: 'common:cancel',
    open: (onDelete) =>
      render(
        <DeleteThreadDialog
          thread={{ id: 't1', title: 'T' } as Thread}
          onDelete={onDelete}
          open
          onOpenChange={() => {}}
          withoutTrigger
        />
      ),
    deleted: (fn) => fn.mock.calls.length > 0,
  },
  {
    name: 'DeleteProjectDialog',
    cancel: 'cancel',
    open: () =>
      render(
        <DeleteProjectDialog open onOpenChange={() => {}} projectId="p1" projectName="P" />
      ),
    deleted: () => deleteFolderWithThreads.mock.calls.length > 0,
  },
  {
    name: 'DeleteAssistantDialog',
    cancel: 'assistants:cancel',
    open: (onDelete) =>
      render(<DeleteAssistantDialog open onOpenChange={() => {}} onConfirm={onDelete} />),
    deleted: (fn) => fn.mock.calls.length > 0,
  },
  {
    name: 'DeleteMessageDialog',
    cancel: 'common:cancel',
    open: (onDelete) => {
      render(<DeleteMessageDialog onDelete={onDelete} />)
      fireEvent.click(screen.getByRole('button', { name: 'common:deleteMessage' }))
    },
    deleted: (fn) => fn.mock.calls.length > 0,
  },
  {
    name: 'DeleteMCPServerConfirm',
    cancel: 'common:cancel',
    open: (onDelete) =>
      render(
        <DeleteMCPServerConfirm
          open
          onOpenChange={() => {}}
          serverName="s"
          onConfirm={onDelete}
        />
      ),
    deleted: (fn) => fn.mock.calls.length > 0,
  },
]

describe.each(cases)('$name', ({ cancel, open, deleted }) => {
  it('opens with focus on Cancel, and Enter there deletes nothing', async () => {
    deleteFolderWithThreads.mockClear()
    const onDelete = vi.fn()
    open(onDelete)
    const cancelButton = await screen.findByRole('button', { name: cancel })
    await waitFor(() => expect(document.activeElement).toBe(cancelButton))

    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' })
    expect(deleted(onDelete)).toBe(false)
  })
})

describe('DeleteMessageDialog names', () => {
  it('gives the confirm button its own name, not the trigger\'s', async () => {
    render(<DeleteMessageDialog onDelete={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'common:deleteMessage' }))
    const confirm = await screen.findByTestId('delete-message-confirm')
    expect(confirm.getAttribute('aria-label')).toBeNull()
    expect(screen.getByRole('button', { name: 'common:delete' })).toBe(confirm)
    // Only the trigger carries the "Delete Message" name.
    expect(screen.getAllByRole('button', { name: 'common:deleteMessage', hidden: true })).toHaveLength(1)
  })
})

describe('DeleteThreadDialog navigation', () => {
  it('only counts the thread whose page is open as in view', async () => {
    const { isOpenInView } = await import('../DeleteThreadDialog')
    window.history.pushState({}, '', '/archive')
    expect(isOpenInView('thread-abc')).toBe(false)
    window.history.pushState({}, '', '/threads/thread-xyz')
    expect(isOpenInView('thread-abc')).toBe(false)
    window.history.pushState({}, '', '/threads/thread-abc')
    expect(isOpenInView('thread-abc')).toBe(true)
    window.history.pushState({}, '', '/')
  })
})

describe('DeleteAssistantDialog archive confirmation', () => {
  it('names the assistant that moves to the Archive', async () => {
    vi.resetModules()
    vi.doMock('@/hooks/useArchiveEnabled', () => ({ useArchiveEnabled: () => true }))
    const { DeleteAssistantDialog: Dialog } = await import('../DeleteAssistantDialog')
    render(
      <Dialog open onOpenChange={() => {}} onConfirm={() => {}} assistantName="Helper" />
    )
    expect(await screen.findByText('archive:moveBody')).toBeTruthy()
    vi.doUnmock('@/hooks/useArchiveEnabled')
  })
})
