import { describe, expect, it } from 'vitest'
import type { MCPServerConfig } from '@/hooks/useMCPServers'
import type { MCPAuthStatus } from '@/services/mcp/types'
import { deriveMcpServerProfile, needsAuthorization } from '../mcpServerProfile'

const auth = (over: Partial<MCPAuthStatus> = {}): MCPAuthStatus => ({
  state: 'unauthenticated',
  canAuthenticate: true,
  hasCredentials: false,
  renewable: false,
  expiresAt: null,
  ...over,
})

const stdio: MCPServerConfig = {
  command: 'npx',
  args: ['-y', 'server-github', ''],
  env: { GITHUB_TOKEN: 'ghp_secret_value' },
  type: 'stdio',
}

describe('deriveMcpServerProfile', () => {
  it('describes a stdio server as a local program whose network use depends on it', () => {
    const profile = deriveMcpServerProfile(stdio)
    expect(profile.transport).toBe('stdio')
    expect(profile.runsWhere).toBe('local-process')
    expect(profile.contactsExternalServices).toBe('depends')
    expect(profile.host).toBeNull()
    expect(profile.requiredAccess).toEqual([
      { kind: 'runs-command', command: 'npx', args: ['-y', 'server-github'] },
      { kind: 'env-vars', names: ['GITHUB_TOKEN'] },
    ])
    expect(profile.appliesTo).toBe('chats-with-tool-capable-models')
  })

  it('treats a config with no type as stdio', () => {
    const { type: _omit, ...untyped } = stdio
    void _omit
    expect(deriveMcpServerProfile(untyped as MCPServerConfig).transport).toBe(
      'stdio'
    )
  })

  it('never includes secret values', () => {
    const remote: MCPServerConfig = {
      command: '',
      args: [],
      env: {},
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer top-secret' },
    }
    const serialized = JSON.stringify([
      deriveMcpServerProfile(stdio),
      deriveMcpServerProfile(remote),
    ])
    expect(serialized).not.toContain('ghp_secret_value')
    expect(serialized).not.toContain('top-secret')
    expect(serialized).toContain('Authorization')
  })

  it('classifies a public http server as a remote service at its host', () => {
    const profile = deriveMcpServerProfile({
      command: '',
      args: [],
      env: {},
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
    })
    expect(profile.runsWhere).toBe('remote-service')
    expect(profile.host).toBe('api.githubcopilot.com')
    expect(profile.contactsExternalServices).toBe('yes')
    expect(profile.requiredAccess).toContainEqual({
      kind: 'connects-to',
      host: 'api.githubcopilot.com',
    })
  })

  it.each([
    'http://127.0.0.1:3845/mcp',
    'http://localhost:8080/sse',
    'http://192.168.1.20:9000/mcp',
  ])('classifies %s as a local endpoint', (url) => {
    const profile = deriveMcpServerProfile({
      command: '',
      args: [],
      env: {},
      type: 'sse',
      url,
    })
    expect(profile.runsWhere).toBe('local-endpoint')
    expect(profile.contactsExternalServices).toBe('depends')
  })

  it('does not guess about a single-label host', () => {
    const profile = deriveMcpServerProfile({
      command: '',
      args: [],
      env: {},
      type: 'http',
      url: 'http://nas:8080/mcp',
    })
    expect(profile.runsWhere).toBe('unresolved-endpoint')
    expect(profile.contactsExternalServices).toBe('depends')
  })

  it('lists authorization as a setup requirement only when the backend says so', () => {
    const base: MCPServerConfig = {
      command: '',
      args: [],
      env: {},
      type: 'http',
      url: 'https://mcp.example.com',
    }
    expect(deriveMcpServerProfile(base, auth()).setupRequirements).toEqual([
      { kind: 'authorization', state: 'unauthenticated' },
    ])
    expect(
      deriveMcpServerProfile(base, auth({ state: 'authenticated' }))
        .setupRequirements
    ).toEqual([])
    expect(
      deriveMcpServerProfile(base, auth({ state: 'staticHeader', canAuthenticate: false }))
        .setupRequirements
    ).toEqual([])
  })

  it('reports missing command, missing url and the browser extension requirement', () => {
    expect(
      deriveMcpServerProfile({ ...stdio, command: '' }).setupRequirements
    ).toContainEqual({ kind: 'missing-command' })
    expect(
      deriveMcpServerProfile({ ...stdio, official: true }).setupRequirements
    ).toContainEqual({ kind: 'browser-extension' })
    expect(
      deriveMcpServerProfile({ command: '', args: [], env: {}, type: 'http' })
        .setupRequirements
    ).toContainEqual({ kind: 'missing-url' })
  })

  it('passes through a description when one is configured', () => {
    expect(
      deriveMcpServerProfile({ ...stdio, description: '  Issues and PRs ' })
        .description
    ).toBe('Issues and PRs')
    expect(deriveMcpServerProfile(stdio).description).toBeNull()
  })
})

describe('needsAuthorization', () => {
  it('is true only for blocking states the user can act on', () => {
    expect(needsAuthorization(undefined)).toBe(false)
    expect(needsAuthorization(auth())).toBe(true)
    expect(needsAuthorization(auth({ state: 'expired' }))).toBe(true)
    expect(needsAuthorization(auth({ state: 'staleResource' }))).toBe(true)
    expect(needsAuthorization(auth({ canAuthenticate: false }))).toBe(false)
    expect(needsAuthorization(auth({ state: 'notApplicable' }))).toBe(false)
  })
})
