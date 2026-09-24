import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(1337))

vi.mock('@/lib/platform', () => ({ isPlatformTauri: () => true }))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ core: () => ({ invoke }) }),
}))

import { APIs } from '../service'

describe('start_server shim', () => {
  beforeEach(() => invoke.mockClear())

  // janhq/jan#8836: the Settings "CORS" switch never reached the server.
  it('forwards the CORS switch to the backend', async () => {
    await APIs.startServer({
      host: '127.0.0.1',
      port: 1337,
      prefix: '/v1',
      apiKey: 'k',
      trustedHosts: ['localhost'],
      isCorsEnabled: false,
      proxyTimeout: 600,
    })
    expect(invoke).toHaveBeenCalledWith('start_server', {
      config: expect.objectContaining({ cors_enabled: false, trusted_hosts: ['localhost'] }),
    })
  })

  // #144: the "Verbose Server Logs" switch was dropped here too.
  it('forwards the verbose logs switch to the backend', async () => {
    await APIs.startServer({ host: '127.0.0.1', port: 1337, isVerboseEnabled: true })
    expect(invoke).toHaveBeenCalledWith('start_server', {
      config: expect.objectContaining({ verbose_logs: true }),
    })
  })

  it('leaves the switch unset when the caller does not say, so the backend keeps CORS on', async () => {
    await APIs.startServer({ host: '127.0.0.1', port: 1337 })
    const { config } = invoke.mock.calls[0][1] as { config: Record<string, unknown> }
    expect(config.cors_enabled).toBeUndefined()
  })
})
