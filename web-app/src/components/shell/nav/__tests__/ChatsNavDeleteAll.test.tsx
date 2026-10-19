import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => undefined,
}))
vi.mock('@/lib/groups/homeMirror', () => ({ startHomeProjectsMirror: () => () => {} }))
vi.mock('@/hooks/useMoveToGroup', () => ({ useMoveToGroup: () => vi.fn() }))
vi.mock('@/components/shell/nav/GroupFoldersDialog', () => ({ GroupFoldersDialog: () => null }))
vi.mock('@/components/shell/nav/GroupPrompts', () => ({ GroupPrompts: () => null }))
vi.mock('@/containers/dialogs/AddProjectDialog', () => ({ default: () => null }))
vi.mock('@/containers/dialogs/DeleteProjectDialog', () => ({ DeleteProjectDialog: () => null }))
vi.mock('@/containers/dialogs/DeleteSelectedThreadsDialog', () => ({
  DeleteSelectedThreadsDialog: () => null,
}))
vi.mock('@/containers/ThreadList', () => ({ default: () => null }))
vi.mock('@/components/shell/nav-kit', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    NavCollapse: Pass,
    NavGroup: Pass,
    NavGroupLabel: Pass,
    NavList: Pass,
    NavGroupAction: ({ children, ...p }: { children?: ReactNode }) => (
      <button type="button" {...p}>
        {children}
      </button>
    ),
    useCloseDrawer: () => () => {},
    useShellNav: () => ({ isMobile: false }),
  }
})

// The real bulk plan and dialog; only the things that touch disk are replaced.
const actOnItem = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/lib/bulkConversationsDeps', async () => {
  const real = await vi.importActual<typeof import('@/lib/bulkConversationsDeps')>(
    '@/lib/bulkConversationsDeps'
  )
  return {
    ...real,
    actOnItem,
    bulkArchiveAvailable: vi.fn().mockResolvedValue(true),
    resyncAfterBulk: vi.fn().mockResolvedValue(undefined),
    undoBulkArchive: vi.fn(),
  }
})

import { ChatsNav } from '../ChatsNav'
import { useThreads } from '@/hooks/useThreads'
import { useThreadManagementStore } from '@/hooks/useThreadManagement'

const chat = (id: string, extra: Partial<Thread> = {}) =>
  ({ id, title: `Chat ${id}`, updated: 1, metadata: {}, ...extra }) as unknown as Thread

const openFilterMenu = async () => {
  const trigger = screen.getAllByRole('button').find((b) => b.getAttribute('aria-label') === 'Filter')
  expect(trigger).toBeTruthy()
  fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false })
  fireEvent.keyDown(trigger!, { key: 'Enter' })
  return await screen.findByTestId('chats-delete-all')
}

beforeEach(() => {
  actOnItem.mockClear()
  useThreadManagementStore.setState({ folders: [] } as never)
})

describe('Chats sidebar menu: Delete all', () => {
  it('is disabled with a hint when there are no chats', async () => {
    useThreads.setState({ threads: {}, isLoadingThreads: false })
    render(<ChatsNav />)
    const row = await openFilterMenu()
    expect(row.getAttribute('data-disabled')).not.toBeNull()
    expect(screen.getByText('Nothing to delete.')).toBeTruthy()
  })

  it('opens the dialog for chats with the whole count and deletes nothing before the typed word', async () => {
    useThreads.setState({
      threads: {
        a: chat('a'),
        b: chat('b'),
        c: chat('c', { isFavorite: true }),
      },
      isLoadingThreads: false,
    })
    render(<ChatsNav />)
    const row = await openFilterMenu()
    expect(row.getAttribute('data-disabled')).toBeNull()
    fireEvent.click(row)

    const dialog = await screen.findByTestId('bulk-dialog')
    // Two chats go, the pinned one stays by default.
    expect(screen.getByTestId('bulk-list').textContent).toContain('Chats: 2')
    expect(screen.getByTestId('bulk-scope').textContent).toMatch(/not only the rows/)
    expect(dialog.textContent).toContain('Archive instead')
    const confirm = screen.getByTestId('bulk-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(actOnItem).not.toHaveBeenCalled()

    // Un-keeping pinned widens the plan to every chat.
    fireEvent.click(screen.getByTestId('bulk-keep-pinned'))
    await waitFor(() => expect(screen.getByTestId('bulk-list').textContent).toContain('Chats: 3'))

    fireEvent.click(screen.getByTestId('bulk-switch-archive'))
    await waitFor(() => expect(screen.queryByTestId('bulk-confirm-input')).toBeNull())
    expect(actOnItem).not.toHaveBeenCalled()
  })
})
