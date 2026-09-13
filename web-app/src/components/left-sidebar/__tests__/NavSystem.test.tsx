import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

let pathname = '/system-monitor'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarGroupLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

import { NavSystem } from '../NavSystem'

describe('NavSystem', () => {
  it('links the monitor and both logs, marking the current page', () => {
    render(<NavSystem />)
    expect(screen.getByRole('link', { name: 'common:systemNav.monitor' })).toHaveAttribute('href', '/system-monitor')
    expect(screen.getByRole('link', { name: 'common:systemNav.appLogs' })).toHaveAttribute('href', '/logs')
    expect(screen.getByRole('link', { name: 'common:systemNav.serverLogs' })).toHaveAttribute('href', '/local-api-server/logs')
    expect(screen.getByRole('link', { name: 'common:systemNav.monitor' })).toHaveAttribute('aria-current', 'page')
  })

  it('marks the logs page when it is current', () => {
    pathname = '/logs'
    render(<NavSystem />)
    expect(screen.getByRole('link', { name: 'common:systemNav.appLogs' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'common:systemNav.monitor' })).not.toHaveAttribute('aria-current')
  })
})
