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
