import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { McpServerAuth } from '@/containers/McpServerAuth'
import type { MCPAuthStatus } from '@/services/mcp/types'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const i18n = (await import('@/i18n/setup')).default
  return {
    useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => i18n.t(k, o) }),
  }
})

const base: MCPAuthStatus = {
  state: 'unauthenticated',
  canAuthenticate: true,
  hasCredentials: false,
  renewable: false,
  expiresAt: null,
  declaredScopes: [],
  requestedScopes: [],
  grantedScopes: [],
  detail: null,
}

const show = (status: MCPAuthStatus) =>
  render(
    <McpServerAuth
      status={status}
      authorizing={false}
      onAuthorize={() => {}}
      onClearAuth={() => {}}
    />
  )

describe('McpServerAuth scopes (AH-135)', () => {
  it('shows what a sign-in will ask for before anyone consents', () => {
    show({ ...base, declaredScopes: ['mcp:read', 'mcp:tools'] })
    expect(screen.getByTestId('mcp-auth-scopes-declared').textContent).toContain('mcp:read mcp:tools')
    // Nothing is stored yet, so there is no grant to show.
    expect(screen.queryByTestId('mcp-auth-scopes-granted')).toBeNull()
  })

  it('shows a narrower grant as what it is', () => {
    show({
      ...base,
      state: 'authenticated',
      hasCredentials: true,
      declaredScopes: ['mcp:read', 'mcp:tools'],
      requestedScopes: ['mcp:read', 'mcp:tools'],
      grantedScopes: ['mcp:read'],
    })
    expect(screen.getByTestId('mcp-auth-scopes-granted').textContent).toContain('mcp:read')
    expect(screen.getByTestId('mcp-auth-scopes-granted').textContent).not.toContain('mcp:tools')
  })

  it('says why a token is not used after the declared scopes changed, and offers a new sign-in', () => {
    show({
      ...base,
      state: 'scopeMismatch',
      hasCredentials: true,
      declaredScopes: ['mcp:admin', 'mcp:read'],
      requestedScopes: ['mcp:read'],
      grantedScopes: ['mcp:read'],
      detail: 'the stored token was asked for [mcp:read] but the configuration declares [mcp:admin mcp:read]',
    })
    expect(screen.getByTestId('mcp-auth-detail').textContent).toContain('configuration declares')
    expect(screen.getByRole('button', { name: /re-authenticate/i })).toBeTruthy()
  })

  it('offers no sign-in while the configuration cannot be read', () => {
    show({
      ...base,
      state: 'invalidScopes',
      canAuthenticate: false,
      detail: "'oauth.scopes' must be a list of strings",
    })
    expect(screen.getByTestId('mcp-auth-detail').textContent).toContain('list of strings')
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull()
  })
})
