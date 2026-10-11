import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

let pathname = '/overview'
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: any) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname }),
  useNavigate: () => vi.fn(),
}))
vi.mock('@/components/shell/nav/CoworkNav', () => ({
  CoworkNav: ({ after }: any) => (
    <>
      <li data-testid="cowork-nav">cowork</li>
      {after}
    </>
  ),
}))
vi.mock('@/components/shell/nav/RoomsNav', () => ({
  RoomsNav: () => <li data-testid="nav-rooms">rooms</li>,
}))
vi.mock('@/components/shell/nav/ChatsNav', () => ({
  ChatsNav: () => <div data-testid="nav-chats">chats</div>,
}))
vi.mock('@/containers/ShortcutHint', () => ({ ShortcutHint: () => null }))
vi.mock('@/containers/PlatformMetaKey', () => ({ PlatformMetaKey: () => null }))

import { AppSidebar } from '../AppSidebar'
import { tabForPath } from '@/lib/sidebarTab'

const links = () =>
  Array.from(screen.getByTestId('app-sidebar').querySelectorAll('a')).map((a) =>
    a.getAttribute('href')
  )

describe('tabForPath', () => {
  it('assigns pages to a tab, and leaves shared pages alone', () => {
    expect(tabForPath('/')).toBe('chat')
    expect(tabForPath('/threads/abc')).toBe('chat')
    expect(tabForPath('/artifacts')).toBe('chat')
    expect(tabForPath('/cowork')).toBe('cowork')
    expect(tabForPath('/campaign/c1')).toBe('cowork')
    expect(tabForPath('/rooms/r1')).toBe('cowork')
    expect(tabForPath('/settings/mcp-servers')).toBe('cowork')
    expect(tabForPath('/overview')).toBeNull()
    expect(tabForPath('/settings/providers')).toBeNull()
    expect(tabForPath('/hub/')).toBeNull()
  })
})

describe('AppSidebar tabs', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('opens the Chat tab on a chat page with its own destinations only', () => {
    pathname = '/'
    render(<AppSidebar />)
    expect(screen.getByTestId('sidebar-tab-chat')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('nav-chats')).toBeInTheDocument()
    expect(screen.queryByTestId('cowork-nav')).toBeNull()
    expect(links()).toEqual(
      expect.arrayContaining(['/artifacts', '/settings/providers', '/hub/'])
    )
    expect(links()).not.toContain('/studio')
    // Resume & usage sits above the tabs, Settings below.
    expect(screen.getByTestId('nav-overview')).toBeInTheDocument()
    expect(screen.getByTestId('cowork-settings')).toBeInTheDocument()
  })

  it('opens the Cowork tab on a Cowork page with one folded More row', () => {
    pathname = '/cowork'
    render(<AppSidebar />)
    expect(screen.getByTestId('sidebar-tab-cowork')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('nav-chats')).toBeNull()
    expect(screen.getByTestId('nav-rooms')).toBeInTheDocument()
    expect(links()).toEqual(
      expect.arrayContaining([
        '/campaigns',
        '/studio',
        '/settings/mcp-servers',
        '/extensions',
        '/settings/schedules',
        '/settings/providers',
        '/hub/',
      ])
    )
    expect(links()).not.toContain('/artifacts')
    const more = screen.getByTestId('nav-more')
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
  })

  it('switches and remembers the tab on a shared page; links are not draggable', () => {
    pathname = '/overview'
    render(<AppSidebar />)
    fireEvent.click(screen.getByTestId('sidebar-tab-cowork'))
    expect(screen.getByTestId('cowork-nav')).toBeInTheDocument()
    expect(localStorage.getItem('flint:sidebar-tab')).toBe('cowork')
    const anchor = screen.getByTestId('rail-models')
    expect(anchor).toHaveAttribute('draggable', 'false')
  })
})
