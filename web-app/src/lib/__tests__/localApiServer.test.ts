import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  classifyServerStartError,
  serverModelsFromActive,
  startLocalApiServer,
  type LocalApiServerConfig,
} from '../localApiServer'

const config: LocalApiServerConfig = {
  serverHost: '127.0.0.1',
  serverPort: 1337,
  apiPrefix: '/v1',
  apiKey: 'k',
  trustedHosts: ['localhost'],
  corsEnabled: true,
  verboseLogs: false,
  proxyTimeout: 600,
  enableServerToolExecution: true,
}

describe('startLocalApiServer', () => {
  const startServer = vi.fn()
  beforeEach(() => {
    startServer.mockReset()
    ;(window as unknown as { core: unknown }).core = { api: { startServer } }
  })
  afterEach(() => {
    delete (window as unknown as { core?: unknown }).core
  })

  it('maps the config to the backend arguments, tool execution included', async () => {
    startServer.mockResolvedValue(1338)
    await expect(startLocalApiServer(config)).resolves.toBe(1338)
    expect(startServer).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 1337,
      prefix: '/v1',
      apiKey: 'k',
      trustedHosts: ['localhost'],
      isCorsEnabled: true,
      isVerboseEnabled: false,
      proxyTimeout: 600,
      enableServerToolExecution: true,
    })
  })

  it('resolves undefined when there is no backend', async () => {
    delete (window as unknown as { core?: unknown }).core
    await expect(startLocalApiServer(config)).resolves.toBeUndefined()
  })
})

describe('serverModelsFromActive', () => {
  it('pairs each active model with its provider and skips unknown ones', () => {
    const providers = [
      { provider: 'llamacpp', models: [{ id: 'a' }, { id: 'b' }] },
      { provider: 'mlx', models: [{ id: 'c' }] },
    ]
    expect(serverModelsFromActive(['a', 'c', 'zzz'], providers)).toEqual([
      { model: 'a', provider: 'llamacpp' },
      { model: 'c', provider: 'mlx' },
    ])
  })
})

describe('classifyServerStartError', () => {
  it('reports a taken port only for the server step', () => {
    const err = { code: 'PORT_IN_USE', message: 'busy' }
    expect(classifyServerStartError(err, 'server')).toEqual({
      kind: 'port-in-use',
      message: 'busy',
    })
    expect(classifyServerStartError(err, 'model').kind).toBe('model')
  })

  it('uses the phase otherwise and reads plain errors and strings', () => {
    expect(classifyServerStartError(new Error('x'), 'server')).toEqual({
      kind: 'server',
      message: 'x',
    })
    expect(classifyServerStartError('plain', 'model')).toEqual({
      kind: 'model',
      message: 'plain',
    })
  })
})
