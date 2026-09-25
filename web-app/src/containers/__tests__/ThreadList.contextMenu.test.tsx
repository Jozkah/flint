import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ThreadList from '../ThreadList'

/**
 * Right-click must open the row's own menu — the same one the three-dot
 * button opens. The point of the shared instance is that an action added to
 * one is an action on the other; a second, parallel menu would drift.
 */

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className, title }: any) => (
    <a className={className} title={title}>
      {children}
    </a>
  ),
  useParams: ({ select }: any = {}) =>
    select ? select({ threadId: undefined }) : { threadId: undefined },
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: (selector: any) =>
    selector({
      deleteThread: vi.fn(),
      renameThread: vi.fn(),
      updateThread: vi.fn(),
    }),
}))

vi.mock('@/hooks/useMessages', () => ({
  useMessages: (selector: any) =>
    selector({ getMessages: () => [], setMessages: vi.fn() }),
}))

vi.mock('@/hooks/useThreadManagement', () => ({
  useThreadManagement: () => ({ folders: [], getFolderById: vi.fn() }),
}))

// Forward the row's handlers, which the other suite's mock drops.
vi.mock('@/components/shell/nav-kit', () => ({
  NavItem: ({ children, ...rest }: any) => (
    <li data-testid="row" tabIndex={0} {...rest}>
      {children}
    </li>
  ),
  NavButton: ({ children }: any) => <div>{children}</div>,
  NavAction: ({ children, showOnHover: _showOnHover, ...rest }: any) => (
    <button data-testid="dots" {...rest}>
      {children}
    </button>
  ),
  useShellNav: () => ({ isMobile: false }),
}))

// A menu that reports whether it is open, and only renders its items then —
// so "the menu opened" is observable without a real popper.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Passthrough = ({ children }: any) => <>{children}</>
  return {
    DropdownMenu: ({ children, open }: any) => (
      <div data-testid="menu" data-open={open ? 'true' : 'false'}>
        {open ? children : null}
      </div>
    ),
    DropdownMenuContent: ({ children }: any) => (
      <div data-testid="menu-content">{children}</div>
    ),
    DropdownMenuItem: ({ children, onSelect }: any) => (
      <button onClick={onSelect}>{children}</button>
    ),
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuSub: Passthrough,
    DropdownMenuSubContent: Passthrough,
    DropdownMenuShortcut: Passthrough,
    DropdownMenuSubTrigger: Passthrough,
  }
})

vi.mock('@/containers/dialogs', () => ({
  RenameThreadDialog: () => null,
  DeleteThreadDialog: () => null,
}))

const thread = { id: 't1', title: 'Some chat', updated: 0, metadata: {} } as Thread

const renderList = (over: Partial<Thread> = {}, projectId?: string) =>
  render(
    <ThreadList threads={[{ ...thread, ...over }]} currentProjectId={projectId} />
  )

const menu = () => screen.getByTestId('menu')

describe('opening the conversation menu', () => {
  it('starts closed', () => {
    renderList()
    expect(menu()).toHaveAttribute('data-open', 'false')
  })

  it('opens on right-click', () => {
    renderList()
    fireEvent.contextMenu(screen.getByTestId('row'))
    expect(menu()).toHaveAttribute('data-open', 'true')
  })

  it('opens with Shift+F10', () => {
    renderList()
    fireEvent.keyDown(screen.getByTestId('row'), { key: 'F10', shiftKey: true })
    expect(menu()).toHaveAttribute('data-open', 'true')
  })

  it('opens with the Menu key', () => {
    renderList()
    fireEvent.keyDown(screen.getByTestId('row'), { key: 'ContextMenu' })
    expect(menu()).toHaveAttribute('data-open', 'true')
  })

  it('ignores F10 without shift, which is not the gesture', () => {
    renderList()
    fireEvent.keyDown(screen.getByTestId('row'), { key: 'F10' })
    expect(menu()).toHaveAttribute('data-open', 'false')
  })
})

describe('what the menu contains', () => {
  it('is one menu, not a second definition beside the button', () => {
    renderList()
    fireEvent.contextMenu(screen.getByTestId('row'))
    expect(screen.getAllByTestId('menu-content')).toHaveLength(1)
  })

  it('keeps rename, project and delete', () => {
    renderList()
    fireEvent.contextMenu(screen.getByTestId('row'))
    expect(screen.getByText('common:rename')).toBeInTheDocument()
    expect(
      screen.getByText('common:projects.moveToGroup')
    ).toBeInTheDocument()
    expect(screen.getByText('common:delete')).toBeInTheDocument()
  })

  it('offers copying the conversation id', () => {
    renderList()
    fireEvent.contextMenu(screen.getByTestId('row'))
    expect(
      screen.getByText('common:copyConversationId')
    ).toBeInTheDocument()
  })

  it('reaches the same menu inside a project', () => {
    // A conversation in a project renders through a different branch; the
    // menu must not be one of the differences.
    renderList({}, 'proj-1')
    fireEvent.contextMenu(screen.getByTestId('row'))
    expect(menu()).toHaveAttribute('data-open', 'true')
    expect(screen.getByText('common:rename')).toBeInTheDocument()
  })
})
