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

const served = vi.hoisted(() => ({ value: true }))
vi.mock('@/lib/platform/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/utils')>()),
  isServedByFlint: () => served.value,
}))

import { AppSidebar } from '../AppSidebar'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { hideableSidebarIds } from '@/lib/sidebarItems'

const hide = (...ids: string[]) =>
  useInterfaceSettings.setState({ hiddenNavItems: ids })
const links = () =>
  Array.from(screen.getByTestId('app-sidebar').querySelectorAll('a')).map((a) =>
    a.getAttribute('href')
  )

describe('AppSidebar in the browser served by flint serve', () => {
  beforeEach(() => {
    localStorage.clear()
    useInterfaceSettings.setState({ hiddenNavItems: [] })
  })

  it('leaves out the rows that only drive the desktop machine', () => {
    pathname = '/cowork'
    render(<AppSidebar />)
    expect(links()).not.toContain('/extensions')
    expect(links()).not.toContain('/settings/schedules')
    fireEvent.click(screen.getByTestId('nav-more'))
    expect(screen.queryByTestId('rail-local-api')).toBeNull()
    expect(links()).toContain('/campaigns')
  })
})
