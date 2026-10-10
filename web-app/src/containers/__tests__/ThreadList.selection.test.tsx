import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import ThreadList from '../ThreadList'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className, title, onClick }: any) => (
    <a className={className} title={title} onClick={onClick}>
      {children}
    </a>
  ),
  useParams: ({ select }: any = {}) =>
    select ? select({ threadId: undefined }) : { threadId: undefined },
  useNavigate: () => vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

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
    selector({
      getMessages: () => [],
      setMessages: vi.fn(),
    }),
}))

vi.mock('@/hooks/useThreadManagement', () => ({
  useThreadManagement: () => ({
    folders: [],
    getFolderById: vi.fn(),
  }),
}))

vi.mock('@/components/shell/nav-kit', () => ({
  NavItem: ({ children }: any) => <li>{children}</li>,
  NavButton: ({ children }: any) => <div>{children}</div>,
  NavAction: ({ children }: any) => <button>{children}</button>,
  useShellNav: () => ({ isMobile: false }),
}))

vi.mock('@/components/ui/dropdown-menu', () => {
  const Passthrough = ({ children }: any) => <>{children}</>
  return {
    DropdownMenu: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: Passthrough,
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


const flush = () => act(() => Promise.resolve())

describe('ThreadList selection mode', () => {
  const threads = [
    { id: 'a', title: 'Alpha', updated: 0, metadata: {} },
    { id: 'b', title: 'Beta', updated: 0, metadata: {} },
  ] as Thread[]

  it('toggles a row instead of opening it and marks selected rows', async () => {
    const toggle = vi.fn()
    render(
      <ThreadList
        threads={threads}
        selection={{ selected: new Set(['a']), toggle }}
      />
    )
    await flush()
    const rows = screen.getAllByTestId('thread-select-box')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('data-checked', 'true')
    expect(rows[1]).toHaveAttribute('data-checked', 'false')
    fireEvent.click(screen.getByText('Beta'))
    expect(toggle).toHaveBeenCalledWith('b')
  })

  it('shows no checkboxes outside selection mode', async () => {
    render(<ThreadList threads={threads} />)
    await flush()
    expect(screen.queryByTestId('thread-select-box')).toBeNull()
  })
})
