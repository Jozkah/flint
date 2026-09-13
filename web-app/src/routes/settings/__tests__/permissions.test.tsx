/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

// Mock-backed: the MCP service, the data folder and the audit command are all
// fakes, so this checks the page's behaviour, not a real Tauri round trip.
vi.mock('@/containers/SettingsMenu', () => ({
  default: () => <div data-testid="settings-menu" />,
}))
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => config,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const named = opts?.server ?? opts?.tool ?? opts?.name ?? opts?.error
      return named !== undefined ? `${key}:${named}` : key
    },
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { toolApproval: 'tool-approval-settings' },
}))
vi.mock('zustand/middleware', () => ({
  persist: (fn: any) => fn,
  createJSONStorage: () => ({
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }),
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: (selector: (s: unknown) => unknown) =>
    selector({ threads: { 'thread-1': { id: 'thread-1', title: 'Fix the parser' } } }),
}))
vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: (selector: (s: unknown) => unknown) =>
    selector({ sessions: [{ id: 'session-7', title: 'Forma cleanup' }] }),
}))

const mcp = {
  trustedServers: vi.fn(),
  revokeServer: vi.fn(),
}
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    mcp: () => mcp,
    app: () => ({ getJanDataFolder: async () => '/data' }),
  }),
}))

const auditRecent = vi.fn()
vi.mock('@/lib/permissionAudit', () => ({
  permissionAuditRecent: (...args: unknown[]) => auditRecent(...args),
}))

import { useToolApproval } from '@/hooks/useToolApproval'
import { Route } from '../permissions'

const Page = () => {
  const Component = (Route as any).component as React.ComponentType
  return <Component />
}

beforeEach(() => {
  vi.clearAllMocks()
  mcp.trustedServers.mockResolvedValue(['github'])
  mcp.revokeServer.mockResolvedValue(undefined)
  auditRecent.mockResolvedValue([])
  useToolApproval.setState({
    approvedTools: { 'thread-1': ['bash', 'write'], 'session-7': ['edit'] },
    approvedServers: ['github', 'local-only'],
    approvedToolsGlobal: ['web_fetch'],
    allowAllMCPPermissions: false,
  })
})

describe('Permissions settings', () => {
  it('lists conversation grants by title, global tools and every trusted server', async () => {
    render(<Page />)
    expect(screen.getByText('Fix the parser')).toBeInTheDocument()
    expect(screen.getByText('Forma cleanup')).toBeInTheDocument()
    expect(screen.getByText('permissions:settings.toolLabel:bash')).toBeInTheDocument()
    expect(
      screen.getByText('permissions:settings.toolLabel:web_fetch')
    ).toBeInTheDocument()
    expect(
      await screen.findByText('permissions:settings.serverLabel:github')
    ).toBeInTheDocument()
    // Remembered by the renderer only: listed, and flagged as such.
    expect(
      screen.getByText('permissions:settings.serverLabel:local-only')
    ).toBeInTheDocument()
    expect(screen.getByText('permissions:settings.serverAppOnly')).toBeInTheDocument()
    expect(screen.getByText('permissions:settings.revokeEffect')).toBeInTheDocument()
  })

  it('revokes a conversation grant', async () => {
    const user = userEvent.setup()
    render(<Page />)
    await user.click(
      screen.getByRole('button', {
        name: 'permissions:settings.revokeLabel:bash (Fix the parser)',
      })
    )
    expect(useToolApproval.getState().approvedTools['thread-1']).toEqual(['write'])
    expect(
      screen.queryByText('permissions:settings.toolLabel:bash')
    ).not.toBeInTheDocument()
  })

  it('revokes a tool allowed everywhere', async () => {
    const user = userEvent.setup()
    render(<Page />)
    await user.click(
      screen.getByRole('button', { name: 'permissions:settings.revokeLabel:web_fetch' })
    )
    expect(useToolApproval.getState().approvedToolsGlobal).toEqual([])
  })

  it('removes a server once the backend has revoked it', async () => {
    const user = userEvent.setup()
    render(<Page />)
    await user.click(
      await screen.findByRole('button', {
        name: 'permissions:settings.revokeLabel:github',
      })
    )
    await waitFor(() =>
      expect(
        screen.queryByText('permissions:settings.serverLabel:github')
      ).not.toBeInTheDocument()
    )
    expect(mcp.revokeServer).toHaveBeenCalledWith('github')
    expect(useToolApproval.getState().approvedServers).toEqual(['local-only'])
  })

  // The backend still trusts it, so showing it as revoked would be false.
  it('keeps a server listed, with the error, when the backend refuses to revoke it', async () => {
    mcp.revokeServer.mockRejectedValue(new Error('disk full'))
    const user = userEvent.setup()
    render(<Page />)
    await user.click(
      await screen.findByRole('button', {
        name: 'permissions:settings.revokeLabel:github',
      })
    )
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('permissions:settings.revokeFailed:github')
    expect(alert).toHaveTextContent('disk full')
    const row = alert.closest('li')!
    expect(
      within(row).getByText('permissions:settings.serverLabel:github')
    ).toBeInTheDocument()
    expect(useToolApproval.getState().approvedServers).toContain('github')
  })

  it('turns off allow-all', async () => {
    useToolApproval.setState({ allowAllMCPPermissions: true })
    const user = userEvent.setup()
    render(<Page />)
    await user.click(screen.getByText('permissions:settings.revokeAll'))
    expect(useToolApproval.getState().allowAllMCPPermissions).toBe(false)
  })

  it('shows recent decisions from the audit log', async () => {
    auditRecent.mockResolvedValue([
      {
        v: 1,
        at: '2026-09-13T10:00:00Z',
        session: 's',
        run: '',
        call: 'c1',
        agent: '',
        project: '',
        tool: 'bash',
        capability: 'exec',
        kind: 'command',
        resource: 'git reset --hard',
        decision: 'deny',
        reason: 'destructive-git:reset-hard',
        rule: '',
      },
    ])
    render(<Page />)
    expect(await screen.findByText('git reset --hard')).toBeInTheDocument()
    expect(auditRecent).toHaveBeenCalledWith('/data', 50)
  })

  it('says when decision history cannot be read', async () => {
    auditRecent.mockRejectedValue(new Error('not in the desktop app'))
    render(<Page />)
    expect(
      await screen.findByText(
        'permissions:settings.historyUnavailable:not in the desktop app'
      )
    ).toBeInTheDocument()
  })

  it('renders the settings-search anchors', () => {
    render(<Page />)
    for (const anchor of [
      'settings-permissions-conversations',
      'settings-permissions-everywhere',
      'settings-permissions-history',
    ]) {
      expect(
        document.querySelector(`[data-setting-anchor="${anchor}"]`)
      ).toBeInTheDocument()
    }
  })
})
