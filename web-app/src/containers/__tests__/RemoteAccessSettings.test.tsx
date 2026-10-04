import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { RemoteAccessSettings, PairPhoneDialog } from '../RemoteAccessSettings'
import { countdown } from '@/lib/remote/format'
import { RemotePairingConfirm } from '../RemotePairingConfirm'
import { useRemoteAccess } from '@/hooks/useRemoteAccess'
import type { RemoteApi, RemoteConfig, RemoteStatus } from '@/lib/remote/api'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) =>
      opts ? `${key}:${Object.values(opts).join(',')}` : key,
  }),
}))

const baseConfig: RemoteConfig = {
  enabled: false,
  interface: 'tailscale',
  port: 1340,
  certPath: null,
  keyPath: null,
  allowApprovals: true,
  allowAlwaysAllow: false,
}

function status(over: Partial<RemoteStatus> = {}, cfg: Partial<RemoteConfig> = {}): RemoteStatus {
  return {
    config: { ...baseConfig, ...cfg },
    running: false,
    serving: null,
    error: null,
    detected: { tailscale: '100.101.1.2', lan: null },
    pairedDevices: 0,
    connectedDevices: 0,
    ...over,
  }
}

function makeApi(initial: RemoteStatus): RemoteApi & { calls: RemoteConfig[] } {
  let current = initial
  const calls: RemoteConfig[] = []
  return {
    calls,
    getStatus: vi.fn(async () => current),
    setConfig: vi.fn(async (config: RemoteConfig) => {
      calls.push(config)
      current = { ...current, config }
      return current
    }),
    startPairing: vi.fn(async () => ({
      code: 'abc',
      confirmNumber: '482913',
      expiresInMs: 300_000,
      url: 'http://100.101.1.2:1340/m/#pair=abc',
    })),
    cancelPairing: vi.fn(async () => {}),
    confirmPairing: vi.fn(async () => ({
      id: 'd2',
      name: 'Pixel 9',
      pairedAt: 0,
      lastSeen: null,
      connected: false,
    })),
    listDevices: vi.fn(async () => [
      { id: 'd1', name: 'Old phone', pairedAt: Date.UTC(2026, 8, 12), lastSeen: null, connected: false },
    ]),
    revokeDevice: vi.fn(async () => true),
    rpcRespond: vi.fn(async () => true),
    emitEvent: vi.fn(async () => {}),
  }
}

beforeEach(() => {
  act(() => {
    useRemoteAccess.setState({ status: null, devices: [], pairingRequest: null, lastPaired: null })
  })
})

describe('RemoteAccessSettings', () => {
  it('shows the detected address and paired phones', async () => {
    const api = makeApi(status())
    render(<RemoteAccessSettings api={api} />)
    expect(await screen.findByTestId('remote-detected')).toHaveTextContent('100.101.1.2')
    expect(screen.getByTestId('remote-devices')).toHaveTextContent('Old phone')
    expect(screen.getByTestId('remote-connection')).toHaveTextContent('remote:notRunning')
    // Pairing needs a running listener.
    expect(screen.getByTestId('remote-pair')).toBeDisabled()
  })

  it('turns remote access on through the backend', async () => {
    const api = makeApi(status())
    render(<RemoteAccessSettings api={api} />)
    fireEvent.click(await screen.findByTestId('remote-enable'))
    await waitFor(() => expect(api.calls.at(-1)?.enabled).toBe(true))
  })

  it('switching approvals off also turns off Always allow', async () => {
    const api = makeApi(status({}, { allowAlwaysAllow: true }))
    render(<RemoteAccessSettings api={api} />)
    fireEvent.click(await screen.findByTestId('remote-allow-approvals'))
    await waitFor(() =>
      expect(api.calls.at(-1)).toMatchObject({ allowApprovals: false, allowAlwaysAllow: false })
    )
    expect(screen.getByTestId('remote-allow-always')).toBeDisabled()
  })

  it('saves a custom host name, and clears it when emptied', async () => {
    const api = makeApi(status())
    render(<RemoteAccessSettings api={api} />)
    const input = await screen.findByTestId('remote-custom-host')
    fireEvent.change(input, { target: { value: ' flint.example.com ' } })
    fireEvent.blur(input)
    await waitFor(() => expect(api.calls.at(-1)?.customHost).toBe('flint.example.com'))
    await waitFor(() => expect(input).toHaveValue('flint.example.com'))
    // Leaving it unchanged saves nothing.
    fireEvent.blur(input)
    expect(api.calls).toHaveLength(1)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    await waitFor(() => expect(api.calls.at(-1)?.customHost).toBeNull())
  })

  it('says so when this install has no phone app, and where it looked', async () => {
    const api = makeApi(status({ phoneApp: false, phoneAppPaths: ['/opt/flint/resources/mobile'] }))
    render(<RemoteAccessSettings api={api} />)
    const note = await screen.findByTestId('remote-no-phone-app')
    expect(note).toHaveTextContent('remote:noPhoneApp')
    expect(note).toHaveTextContent('/opt/flint/resources/mobile')
  })

  it('says nothing about the phone app when it is there, or the backend is older', async () => {
    render(<RemoteAccessSettings api={makeApi(status({ phoneApp: true }))} />)
    await screen.findByTestId('remote-detected')
    expect(screen.queryByTestId('remote-no-phone-app')).toBeNull()
  })

  it('removes a paired phone', async () => {
    const api = makeApi(status())
    render(<RemoteAccessSettings api={api} />)
    fireEvent.click(await screen.findByTestId('remote-remove-d1'))
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith('d1'))
  })

  it('shows the fingerprint of a self-signed certificate', async () => {
    const api = makeApi(
      status(
        {
          running: true,
          serving: {
            address: '192.168.1.20',
            host: '192.168.1.20',
            port: 1340,
            https: true,
            tlsSource: 'self_signed',
            fingerprint: 'AB:CD',
            baseUrl: 'https://192.168.1.20:1340',
          },
        },
        { enabled: true, interface: 'lan' }
      )
    )
    render(<RemoteAccessSettings api={api} />)
    expect(await screen.findByTestId('remote-fingerprint')).toHaveTextContent('AB:CD')
    expect(screen.getByTestId('remote-pair')).not.toBeDisabled()
  })
})

describe('PairPhoneDialog', () => {
  it('shows a QR code, the number and a countdown', async () => {
    const api = makeApi(status())
    render(<PairPhoneDialog api={api} onClose={() => {}} />)
    expect(await screen.findByTestId('remote-qr')).toBeInTheDocument()
    expect(screen.getByTestId('remote-pair-number')).toHaveTextContent('482 913')
    expect(screen.getByTestId('remote-pair-expiry')).toHaveTextContent('5:00')
  })

  it('countdown formats and never goes negative', () => {
    expect(countdown(65_000, 0)).toBe('1:05')
    expect(countdown(0, 10_000)).toBe('0:00')
  })
})

describe('RemotePairingConfirm', () => {
  it('pairs only when the user confirms', async () => {
    const api = makeApi(status())
    act(() => {
      useRemoteAccess.setState({
        pairingRequest: { requestId: 'q1', deviceName: 'Pixel 9', confirmNumber: '482913' },
      })
    })
    render(<RemotePairingConfirm api={api} />)
    expect(screen.getByTestId('remote-confirm-number')).toHaveTextContent('482 913')
    expect(api.confirmPairing).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('remote-confirm'))
    await waitFor(() => expect(api.confirmPairing).toHaveBeenCalledWith('q1', true))
    await waitFor(() => expect(useRemoteAccess.getState().lastPaired?.name).toBe('Pixel 9'))
    expect(screen.queryByTestId('remote-confirm-dialog')).toBeNull()
  })

  it('refuses when dismissed', async () => {
    const api = makeApi(status())
    act(() => {
      useRemoteAccess.setState({
        pairingRequest: { requestId: 'q1', deviceName: 'Pixel 9', confirmNumber: '482913' },
      })
    })
    render(<RemotePairingConfirm api={api} />)
    fireEvent.keyDown(screen.getByTestId('remote-confirm-dialog'), { key: 'Escape' })
    await waitFor(() => expect(api.confirmPairing).toHaveBeenCalledWith('q1', false))
  })
})
