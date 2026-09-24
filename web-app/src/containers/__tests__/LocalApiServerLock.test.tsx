/**
 * #111: while the Local API Server runs, its configuration fields were locked
 * only with `pointer-events-none`. Keyboard focus still reached them, and a
 * blur persisted the edit. They must be really disabled (or read-only) and
 * must not write to the store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const store = vi.hoisted(() => ({
  apiKey: 'secret',
  setApiKey: vi.fn(),
  serverPort: 1337,
  setServerPort: vi.fn(),
  trustedHosts: ['a.local'],
  setTrustedHosts: vi.fn(),
  apiPrefix: '/v1',
  setApiPrefix: vi.fn(),
  proxyTimeout: 600,
  setProxyTimeout: vi.fn(),
  serverHost: '127.0.0.1',
  setServerHost: vi.fn(),
}))

vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: () => store,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { ApiKeyInput } from '../ApiKeyInput'
import { PortInput } from '../PortInput'
import { TrustedHostsInput } from '../TrustedHostsInput'
import { ApiPrefixInput } from '../ApiPrefixInput'
import { ProxyTimeoutInput } from '../ProxyTimeoutInput'
import { ServerHostSwitcher } from '../ServerHostSwitcher'

beforeEach(() => vi.clearAllMocks())

const cases = [
  { name: 'PortInput', el: <PortInput isServerRunning />, value: '8080', setter: () => store.setServerPort },
  { name: 'TrustedHostsInput', el: <TrustedHostsInput isServerRunning />, value: 'evil.com', setter: () => store.setTrustedHosts },
  { name: 'ApiPrefixInput', el: <ApiPrefixInput isServerRunning />, value: '/v2', setter: () => store.setApiPrefix },
  { name: 'ProxyTimeoutInput', el: <ProxyTimeoutInput isServerRunning />, value: '5', setter: () => store.setProxyTimeout },
]

describe('Local API Server fields while running', () => {
  it.each(cases)('$name is disabled and does not persist on blur', ({ el, value, setter }) => {
    const { container } = render(el)
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.disabled).toBe(true)
    fireEvent.change(input, { target: { value } })
    fireEvent.blur(input)
    expect(setter()).not.toHaveBeenCalled()
  })

  it('ApiKeyInput is read-only and does not persist on blur', () => {
    const { container } = render(<ApiKeyInput isServerRunning />)
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    fireEvent.change(input, { target: { value: 'changed' } })
    fireEvent.blur(input)
    expect(store.setApiKey).not.toHaveBeenCalled()
  })

  it('ServerHostSwitcher trigger is disabled', () => {
    render(<ServerHostSwitcher isServerRunning />)
    expect((screen.getByTitle('Edit Server Host') as HTMLButtonElement).disabled).toBe(true)
  })

  it('still persists when the server is stopped', () => {
    const { container } = render(<PortInput />)
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.disabled).toBe(false)
    fireEvent.change(input, { target: { value: '8080' } })
    fireEvent.blur(input)
    expect(store.setServerPort).toHaveBeenCalledWith(8080)
  })
})
