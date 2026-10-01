import { describe, expect, it } from 'vitest'
import type { MCPAuthStatus } from '@/services/mcp/types'
import {
  activationConfirmed,
  activationFailed,
  beginActivation,
  classifyActivationFailure,
  deriveConnectionState,
  runtimeCleared,
  type McpConnectionInput,
} from '../mcpConnectionState'

const input = (over: Partial<McpConnectionInput> = {}): McpConnectionInput => ({
  installed: true,
  enabled: false,
  connected: false,
  transport: 'stdio',
  ...over,
})

const unauthenticated: MCPAuthStatus = {
  state: 'unauthenticated',
  canAuthenticate: true,
  hasCredentials: false,
  renewable: false,
  expiresAt: null,
}

describe('deriveConnectionState', () => {
  it('not-installed when there is no config', () => {
    expect(deriveConnectionState(input({ installed: false })).state).toBe(
      'not-installed'
    )
  })

  it('disabled when configured and off', () => {
    const snap = deriveConnectionState(input())
    expect(snap.state).toBe('disabled')
    expect(snap.switchOn).toBe(false)
  })

  it('connecting while an activation is in flight, with the switch on', () => {
    const snap = deriveConnectionState(input({ runtime: beginActivation() }))
    expect(snap.state).toBe('connecting')
    expect(snap.switchOn).toBe(true)
  })

  it('connected only when the backend lists it', () => {
    expect(
      deriveConnectionState(input({ enabled: true, connected: false })).state
    ).toBe('not-connected')
    expect(
      deriveConnectionState(input({ enabled: true, connected: true })).state
    ).toBe('connected')
  })

  it('failed keeps the message and reverts the switch to the saved flag', () => {
    const failure = classifyActivationFailure(
      new Error('spawn npx ENOENT'),
      'stdio'
    )
    const snap = deriveConnectionState(
      input({ enabled: false, runtime: activationFailed(failure) })
    )
    expect(snap.state).toBe('failed')
    expect(snap.switchOn).toBe(false)
    expect(snap.failure?.message).toBe('spawn npx ENOENT')
    expect(snap.nextStep).toBe('check-command')
  })

  it('a recorded failure outranks a stale connected entry', () => {
    const failure = classifyActivationFailure('boom', 'http')
    expect(
      deriveConnectionState(
        input({ connected: true, runtime: activationFailed(failure) })
      ).state
    ).toBe('failed')
  })

  it('needs-authorization from a tagged activation error', () => {
    const failure = classifyActivationFailure(
      'NEEDS_AUTH: 401 from https://mcp.example.com',
      'http'
    )
    expect(failure.needsAuth).toBe(true)
    expect(failure.nextStep).toBe('authorize')
    expect(failure.message).toBe('401 from https://mcp.example.com')
    expect(
      deriveConnectionState(
        input({ transport: 'http', runtime: activationFailed(failure) })
      ).state
    ).toBe('needs-authorization')
  })

  it('needs-authorization from auth status when enabled but not connected', () => {
    const snap = deriveConnectionState(
      input({ enabled: true, transport: 'http', authStatus: unauthenticated })
    )
    expect(snap.state).toBe('needs-authorization')
    expect(snap.nextStep).toBe('authorize')
  })

  it('points http failures at the URL', () => {
    expect(classifyActivationFailure({ message: 'refused' }, 'sse').nextStep).toBe(
      'check-url'
    )
  })

  it('confirmation and clearing return to idle', () => {
    expect(activationConfirmed()).toEqual({ activating: false, failure: null })
    expect(runtimeCleared()).toEqual({ activating: false, failure: null })
  })
})

describe('deriveConnectionState – on-demand lifecycle', () => {
  it('an enabled, stopped server reads as stopped (starts when needed)', () => {
    const s = deriveConnectionState(
      input({ enabled: true, lifecycle: { state: 'stopped' } })
    )
    expect(s.state).toBe('stopped')
    expect(s.switchOn).toBe(true)
    expect(s.nextStep).toBeNull()
  })

  it('a lazy start in flight reads as connecting', () => {
    expect(
      deriveConnectionState(input({ enabled: true, lifecycle: { state: 'starting' } }))
        .state
    ).toBe('connecting')
  })

  it('a failed lazy start shows the backend error', () => {
    const s = deriveConnectionState(
      input({ enabled: true, lifecycle: { state: 'failed', error: 'spawn npx ENOENT' } })
    )
    expect(s.state).toBe('failed')
    expect(s.failure?.message).toContain('ENOENT')
    expect(s.nextStep).toBe('check-command')
  })

  it('a running server is connected whatever the lifecycle says', () => {
    expect(
      deriveConnectionState(
        input({ enabled: true, connected: true, lifecycle: { state: 'running' } })
      ).state
    ).toBe('connected')
  })

  it('without a lifecycle the old not-connected state stays', () => {
    expect(deriveConnectionState(input({ enabled: true })).state).toBe('not-connected')
  })
})
