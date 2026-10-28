/**
 * CTB-016 / janhq/jan#9470: trusted hosts saved only on blur, accepted any
 * text, and gave no reason when locked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const store = vi.hoisted(() => ({
  trustedHosts: ['a.local'] as string[],
  setTrustedHosts: vi.fn(),
}))

vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: () => store,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { hosts?: string }) => (o?.hosts ? `${k}:${o.hosts}` : k),
  }),
}))

import { TrustedHostsInput, isValidTrustedHost } from '../TrustedHostsInput'

beforeEach(() => {
  vi.clearAllMocks()
  store.trustedHosts = ['a.local']
})

const setup = (running = false) => {
  const utils = render(<TrustedHostsInput isServerRunning={running} />)
  const input = utils.container.querySelector('input') as HTMLInputElement
  return { ...utils, input }
}

describe('isValidTrustedHost', () => {
  it.each([
    '*',
    'example.com',
    'example.com:3000',
    'localhost',
    '192.168.1.5',
    '192.168.1.5:8080',
    '[::1]',
    '[fe80::1]:1337',
    'http://host:3000',
    'https://app.example.com/',
    'chrome-extension://abcdefghijklmnop',
  ])('accepts %s', (h) => expect(isValidTrustedHost(h)).toBe(true))

  it.each([
    '*.example.com',
    'http://host/path',
    'host/path',
    'host:0',
    'host:99999',
    'host:abc',
    'has space',
    '::1',
    '[::1',
    'user@host',
    'http://',
  ])('rejects %s', (h) => expect(isValidTrustedHost(h)).toBe(false))
})

describe('TrustedHostsInput', () => {
  it('saves on Enter, trimmed and deduplicated', () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: ' b.local , b.local,c.local:3000 ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(store.setTrustedHosts).toHaveBeenCalledWith(['b.local', 'c.local:3000'])
  })

  it('saves on blur', () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'b.local' } })
    fireEvent.blur(input)
    expect(store.setTrustedHosts).toHaveBeenCalledWith(['b.local'])
  })

  it('saves a pending edit when the field unmounts', () => {
    const { input, unmount } = setup()
    fireEvent.change(input, { target: { value: 'b.local' } })
    unmount()
    expect(store.setTrustedHosts).toHaveBeenCalledWith(['b.local'])
  })

  it('does not write when nothing changed', () => {
    const { input, unmount } = setup()
    fireEvent.blur(input)
    unmount()
    expect(store.setTrustedHosts).not.toHaveBeenCalled()
  })

  it('reverts to the stored value on Escape', () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'b.local' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('a.local')
    fireEvent.blur(input)
    expect(store.setTrustedHosts).not.toHaveBeenCalled()
  })

  it('shows an inline error and does not save invalid entries', () => {
    const { input, unmount } = setup()
    fireEvent.change(input, { target: { value: 'ok.local, http://x/path' } })
    expect(screen.getByRole('alert').textContent).toContain('http://x/path')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    unmount()
    expect(store.setTrustedHosts).not.toHaveBeenCalled()
  })

  it('marks unsaved text until it is committed', () => {
    const { input } = setup()
    expect(screen.queryByText('settings:localApiServer.trustedHostsUnsaved')).toBeNull()
    fireEvent.change(input, { target: { value: 'b.local' } })
    expect(screen.getByText('settings:localApiServer.trustedHostsUnsaved')).toBeTruthy()
  })

  it('explains the lock while the server runs and never saves', () => {
    const { input, unmount } = setup(true)
    expect(input.disabled).toBe(true)
    expect(screen.getByText('settings:localApiServer.stopServerToEdit')).toBeTruthy()
    fireEvent.change(input, { target: { value: 'b.local' } })
    unmount()
    expect(store.setTrustedHosts).not.toHaveBeenCalled()
  })
})
