/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const h = vi.hoisted(() => ({
  state: {} as Record<string, any>,
  setProxyIgnoreSSL: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => config,
}))
vi.mock('@/lib/desktopOnlyRoute', () => ({
  desktopOnlyRoute: (Page: any) => Page,
}))
vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
vi.mock('@/containers/SettingsPageHeader', () => ({
  SettingsPageHeader: () => null,
  SettingsPageBody: ({ children }: any) => <div>{children}</div>,
}))
vi.mock('@/containers/Card', () => ({
  Card: ({ aside, children }: any) => (
    <section>
      {aside}
      {children}
    </section>
  ),
  CardItem: ({ title, description, actions }: any) => (
    <div>
      <h3>{title}</h3>
      {description}
      {actions}
    </div>
  ),
}))
vi.mock('@/containers/CaBundleStatus', () => ({ CaBundleStatus: () => null }))
vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => false }))
vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({}) }))
vi.mock('@/hooks/useProxyConfig', () => ({
  useProxyConfig: () => h.state,
}))

import { Route } from '../network-proxy'

const Page = () => {
  const Component = (Route as any).component as React.ComponentType
  return <Component />
}

beforeEach(() => {
  h.setProxyIgnoreSSL.mockClear()
  h.state = {
    proxyUrl: '',
    proxyEnabled: true,
    proxyUsername: '',
    proxyPassword: '',
    proxyIgnoreSSL: false,
    noProxy: '',
    caBundlePath: '',
    setProxyEnabled: vi.fn(),
    setProxyUsername: vi.fn(),
    setProxyPassword: vi.fn(),
    setProxyIgnoreSSL: h.setProxyIgnoreSSL,
    setNoProxy: vi.fn(),
    setProxyUrl: vi.fn(),
    setCaBundlePath: vi.fn(),
  }
})

describe('Settings > Network proxy', () => {
  it('gives every input an accessible name', () => {
    render(<Page />)
    expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Username')).toHaveAttribute(
      'autocomplete',
      'off'
    )
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'autocomplete',
      'new-password'
    )
    expect(screen.getByLabelText('No Proxy')).toBeInTheDocument()
    expect(screen.getByLabelText('Custom CA bundle')).toBeInTheDocument()
  })

  it('shows an inline error for an unusable proxy address', () => {
    h.state.proxyUrl = 'ftp://proxy'
    render(<Page />)
    expect(screen.getByRole('alert')).toHaveTextContent(/http, https, socks5 and socks5h/i)
    expect(screen.getByLabelText('Proxy URL')).toHaveAttribute(
      'aria-invalid',
      'true'
    )
  })

  it('shows no error for a good address', () => {
    h.state.proxyUrl = 'http://proxy.example.com:8080'
    render(<Page />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('asks before ignoring SSL certificates and only then applies it', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('switch', { name: /allow invalid certificates/i }))
    expect(h.setProxyIgnoreSSL).not.toHaveBeenCalled()
    expect(screen.getByText('Ignore SSL certificates?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ignore certificates' }))
    expect(h.setProxyIgnoreSSL).toHaveBeenCalledWith(true)
  })

  it('cancelling the confirmation leaves SSL checks on', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('switch', { name: /allow invalid certificates/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(h.setProxyIgnoreSSL).not.toHaveBeenCalled()
  })

  it('turns SSL checks back on immediately and warns while they are off', () => {
    h.state.proxyIgnoreSSL = true
    render(<Page />)
    expect(screen.getByRole('note')).toHaveTextContent(/checks are off/i)
    fireEvent.click(screen.getByRole('switch', { name: /allow invalid certificates/i }))
    expect(h.setProxyIgnoreSSL).toHaveBeenCalledWith(false)
    expect(screen.queryByText('Ignore SSL certificates?')).toBeNull()
  })
})
