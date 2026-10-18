import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import ThreadList from '../ThreadList'

const { setOpenMobile } = vi.hoisted(() => ({ setOpenMobile: vi.fn() }))

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
  useShellNav: () => ({ isMobile: true, setOpenMobile }),
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


const thread = { id: 't1', title: 'A chat', updated: 0, metadata: {} } as Thread

describe('ThreadList on a narrow window', () => {
  it('closes the navigation sheet when a chat is picked, also the open one', async () => {
    setOpenMobile.mockClear()
    render(<ThreadList threads={[thread]} />)
    await act(() => Promise.resolve())
    fireEvent.click(screen.getByText('A chat'))
    expect(setOpenMobile).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByText('A chat'))
    expect(setOpenMobile).toHaveBeenCalledTimes(2)
  })

  it('keeps the sheet while selecting chats for bulk delete', async () => {
    setOpenMobile.mockClear()
    const toggle = vi.fn()
    render(
      <ThreadList threads={[thread]} selection={{ selected: new Set(), toggle }} />
    )
    await act(() => Promise.resolve())
    fireEvent.click(screen.getByText('A chat'))
    expect(toggle).toHaveBeenCalledWith('t1')
    expect(setOpenMobile).not.toHaveBeenCalled()
  })
})
