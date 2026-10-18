import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

let pathname = '/'
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
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { hiddenForPreset, hideableSidebarIds } from '@/lib/sidebarItems'

const hide = (...ids: string[]) =>
  useInterfaceSettings.setState({ hiddenNavItems: ids })
const links = () =>
  Array.from(screen.getByTestId('app-sidebar').querySelectorAll('a')).map((a) =>
    a.getAttribute('href')
  )

describe('AppSidebar with hidden items', () => {
  beforeEach(() => {
    localStorage.clear()
    hide()
  })

  it('shows everything by default', () => {
    pathname = '/'
    render(<AppSidebar />)
    expect(screen.getByTestId('rail-library')).toBeInTheDocument()
    expect(screen.getByTestId('rail-discover')).toBeInTheDocument()
    expect(screen.getByTestId('nav-overview')).toBeInTheDocument()
  })

  it('leaves hidden Chat items out and keeps the rest', () => {
    pathname = '/'
    hide('library', 'translate', 'discover', 'overview')
    render(<AppSidebar />)
    expect(screen.queryByTestId('rail-library')).toBeNull()
    expect(screen.queryByTestId('rail-translate')).toBeNull()
    expect(screen.queryByTestId('rail-discover')).toBeNull()
    expect(screen.queryByTestId('nav-overview')).toBeNull()
    expect(screen.getByTestId('rail-models')).toBeInTheDocument()
    expect(screen.getByTestId('nav-new-chat')).toBeInTheDocument()
  })

  it('leaves hidden Cowork items out, and drops the empty More row', () => {
    pathname = '/cowork'
    hide('studio', 'logs', 'archive', 'local-api', 'system-monitor')
    render(<AppSidebar />)
    expect(links()).not.toContain('/studio')
    expect(links()).toContain('/campaigns')
    expect(screen.queryByTestId('nav-more')).toBeNull()
  })

  it('keeps More while one of its items is still shown', () => {
    pathname = '/cowork'
    hide('logs', 'archive', 'local-api')
    render(<AppSidebar />)
    fireEvent.click(screen.getByTestId('nav-more'))
    expect(screen.getByTestId('rail-system')).toBeInTheDocument()
    expect(screen.queryByTestId('nav-logs')).toBeNull()
  })

  it('still renders, with Settings and New chat, when every optional item is hidden', () => {
    pathname = '/'
    hide(...hideableSidebarIds())
    render(<AppSidebar />)
    expect(screen.getByTestId('cowork-settings')).toBeInTheDocument()
    expect(screen.getByTestId('nav-new-chat')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-tabs')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('sidebar-tab-cowork'))
    expect(screen.getByTestId('cowork-nav')).toBeInTheDocument()
    expect(screen.getByTestId('cowork-settings')).toBeInTheDocument()
  })

  it('does not break on the page of an item that is hidden', () => {
    pathname = '/studio'
    hide('studio')
    render(<AppSidebar />)
    expect(links()).not.toContain('/studio')
    expect(screen.getByTestId('cowork-settings')).toBeInTheDocument()
  })

  it('minimal preset: Chat shows New chat and Models, Cowork no More row or empty heading', () => {
    pathname = '/'
    hide(...hiddenForPreset('minimal'))
    render(<AppSidebar />)
    expect(screen.getByTestId('nav-new-chat')).toBeInTheDocument()
    expect(screen.getByTestId('rail-models')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-discover')).toBeNull()
    expect(screen.queryByTestId('nav-overview')).toBeNull()
    fireEvent.click(screen.getByTestId('sidebar-tab-cowork'))
    expect(screen.getByTestId('cowork-nav')).toBeInTheDocument()
    expect(screen.queryByTestId('nav-more')).toBeNull()
    expect(screen.queryByTestId('nav-studio')).toBeNull()
    expect(screen.getByTestId('cowork-settings')).toBeInTheDocument()
  })

  it('ignores ids it does not know and cannot hide Settings', () => {
    pathname = '/'
    hide('ghost', 'settings', 'new-chat')
    render(<AppSidebar />)
    expect(screen.getByTestId('cowork-settings')).toBeInTheDocument()
    expect(screen.getByTestId('nav-new-chat')).toBeInTheDocument()
    expect(screen.getByTestId('rail-library')).toBeInTheDocument()
  })
})
