/**
 * The Environment readiness section.
 *
 * The behaviours asserted here are the ones that were wrong before: a session
 * whose shell failed reported that Jan could not start, and the reason it gave
 * was about where Git was installed. The section must now show seven working
 * components as working, one failed component with the true reason, and must
 * not recommend reinstalling anything.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  ComponentReport,
  EnvironmentReadiness,
  ReadinessComponent,
  ReadinessReason,
  ReadinessState,
} from '@janhq/tauri-plugin-agent-tools-api'

const environmentReadiness = vi.fn()
const environmentReadinessRetry = vi.fn()

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  environmentReadiness: (...a: unknown[]) => environmentReadiness(...a),
  environmentReadinessRetry: (...a: unknown[]) =>
    environmentReadinessRetry(...a),
}))

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))

import {
  CoworkEnvironmentReadiness,
  diagnosticsText,
  unreadyCount,
} from '../CoworkEnvironmentReadiness'

const report = (
  component: ReadinessComponent,
  state: ReadinessState,
  reason: ReadinessReason,
  message: string,
  extra: Partial<ComponentReport> = {}
): ComponentReport => ({
  component,
  state,
  reason,
  message,
  checkedAtMs: 1_700_000_000_000,
  retryable: true,
  capabilities: [],
  details: [],
  ...extra,
})

/** The machine from the bug report: everything works except the shell. */
const windowsWithoutBash = (): EnvironmentReadiness => ({
  generatedAtMs: 1_700_000_000_000,
  components: [
    report('model', 'ready', 'ok', 'Connected.', { retryable: false }),
    report('context', 'ready', 'ok', '32,768 tokens.', { retryable: false }),
    report('filesystem', 'ready', 'ok', 'Readable and writable.', {
      retryable: false,
    }),
    report(
      'shell',
      'unavailable',
      'shell-runtime-incompatible',
      'git-bash is installed and cannot run inside the sandbox: the MSYS2 runtime it is built on cannot start in a Windows AppContainer. Installing Git somewhere else will not change this. Chat, file reading and editing are unaffected.',
      {
        retryable: false,
        details: ['bash.exe (git-bash, system-install): unusable'],
      }
    ),
    report('sandbox', 'ready', 'ok', 'Commands will be confined.', {
      retryable: false,
      details: ['backend=appcontainer'],
    }),
    report('mcp', 'ready', 'ok', 'No servers configured.', {
      retryable: false,
    }),
    report('workspace', 'ready', 'ok', 'A folder is attached.', {
      retryable: false,
    }),
    report('local-runtime', 'ready', 'ok', 'Serving.', { retryable: false }),
  ],
})

describe('CoworkEnvironmentReadiness', () => {
  beforeEach(() => {
    environmentReadiness.mockReset().mockResolvedValue(windowsWithoutBash())
    environmentReadinessRetry.mockReset()
    navigate.mockReset()
  })

  it('probes the backend for the attached folder', async () => {
    render(<CoworkEnvironmentReadiness projectRoot="/proj" />)
    await waitFor(() =>
      expect(environmentReadiness).toHaveBeenCalledWith('/proj', undefined)
    )
  })

  it('renders a row for every component', async () => {
    render(<CoworkEnvironmentReadiness />)
    for (const label of [
      'Model',
      'Context',
      'Files',
      'Shell',
      'Sandbox',
      'MCP',
      'Workspace',
      'Local runtime',
    ]) {
      expect(await screen.findByText(label)).toBeInTheDocument()
    }
  })

  /// Eight rows each explaining that they are fine would bury the one that is
  /// not, so a ready row carries its state in the icon and says nothing else.
  it('stays quiet about the components that are working', async () => {
    render(<CoworkEnvironmentReadiness />)
    await screen.findByText('Model')
    expect(screen.getByTestId('readiness-summary-model')).toHaveTextContent('')
    expect(screen.getByTestId('readiness-summary-filesystem')).toHaveTextContent(
      ''
    )
    expect(screen.getByTestId('readiness-summary-shell')).toHaveTextContent(
      /MSYS2/
    )
  })

  it('counts only what is genuinely unavailable', async () => {
    render(<CoworkEnvironmentReadiness />)
    expect(
      await screen.findByTestId('environment-readiness-unready')
    ).toHaveTextContent('1 unavailable')
    expect(unreadyCount(windowsWithoutBash())).toBe(1)
    expect(unreadyCount(null)).toBe(0)
  })

  /// The whole point of the fix: the shell answer says MSYS2 cannot start in
  /// an AppContainer, and never that Git is in the wrong place.
  it('gives the true reason for Git Bash and does not blame the install', async () => {
    render(<CoworkEnvironmentReadiness />)
    const summary = await screen.findByTestId('readiness-summary-shell')
    expect(summary).toHaveTextContent(/MSYS2/)
    expect(summary).toHaveTextContent(/will not change this/)
    expect(summary).not.toHaveTextContent(/user profile/i)
    expect(summary).not.toHaveTextContent(/reinstall/i)
    expect(summary).not.toHaveTextContent(/system-wide/i)
  })

  /// A cause that cannot change must not offer a retry, or the button implies
  /// the diagnosis is a guess.
  it('offers no retry for a cause a retry cannot change', async () => {
    render(<CoworkEnvironmentReadiness />)
    await userEvent.click(await screen.findByText('Shell'))
    expect(screen.queryByTestId('readiness-retry-shell')).toBeNull()
    // It still offers somewhere to go.
    expect(screen.getByTestId('readiness-action-shell')).toBeInTheDocument()
  })

  it('retries one component without disturbing the others', async () => {
    const retried = windowsWithoutBash()
    retried.components[3] = report(
      'shell',
      'ready',
      'ok',
      'git-bash starts inside the sandbox.'
    )
    environmentReadiness.mockResolvedValue({
      ...windowsWithoutBash(),
      components: windowsWithoutBash().components.map((c) =>
        c.component === 'mcp'
          ? report('mcp', 'unavailable', 'mcp-unreachable', 'A server did not start.')
          : c
      ),
    })
    environmentReadinessRetry.mockResolvedValue(retried)

    render(<CoworkEnvironmentReadiness projectRoot="/proj" />)
    await userEvent.click(await screen.findByText('MCP'))
    await userEvent.click(screen.getByTestId('readiness-retry-mcp'))

    expect(environmentReadinessRetry).toHaveBeenCalledWith(
      '/proj',
      'mcp',
      undefined
    )
  })

  it('retries everything from the header', async () => {
    environmentReadinessRetry.mockResolvedValue(windowsWithoutBash())
    render(<CoworkEnvironmentReadiness projectRoot="/proj" />)
    await userEvent.click(
      await screen.findByTestId('environment-readiness-retry-all')
    )
    expect(environmentReadinessRetry).toHaveBeenCalledWith(
      '/proj',
      undefined,
      undefined
    )
  })

  it('opens the setting a failed component points at', async () => {
    render(<CoworkEnvironmentReadiness />)
    await userEvent.click(await screen.findByText('Shell'))
    await userEvent.click(screen.getByTestId('readiness-action-shell'))
    expect(navigate).toHaveBeenCalledWith({ to: '/settings/agent-tools' })
  })

  it('reports a failure to read readiness instead of rendering nothing', async () => {
    environmentReadiness.mockRejectedValue(new Error('IPC is down'))
    render(<CoworkEnvironmentReadiness />)
    expect(await screen.findByText(/IPC is down/)).toBeInTheDocument()
  })

  /// Details are collapsed: the section is reference material, not a wall.
  it('shows details only for the row that was expanded', async () => {
    render(<CoworkEnvironmentReadiness />)
    await screen.findByText('Sandbox')
    expect(screen.queryByText('backend=appcontainer')).toBeNull()
    await userEvent.click(screen.getByText('Sandbox'))
    expect(screen.getByText('backend=appcontainer')).toBeInTheDocument()
  })
})

describe('the copied diagnostics', () => {
  /// Meant to be pasted into a bug report by someone who should not have to
  /// audit it for their own secrets first.
  it('carry names, states and reason codes and no values', () => {
    const text = diagnosticsText(windowsWithoutBash())
    expect(text).toContain('Shell: unavailable [shell-runtime-incompatible]')
    expect(text).toContain('Sandbox: ready [ok]')
    expect(text).toContain('bash.exe (git-bash, system-install)')
    // Nothing in the report is a value, a full path or a credential.
    expect(text).not.toMatch(/C:\\Users/i)
    expect(text).not.toMatch(/sk-/)
    expect(text).not.toMatch(/api[_-]?key/i)
  })

  it('names every component so a missing row is visible in the paste', () => {
    const text = diagnosticsText(windowsWithoutBash())
    for (const label of [
      'Model',
      'Context',
      'Files',
      'Shell',
      'Sandbox',
      'MCP',
      'Workspace',
      'Local runtime',
    ]) {
      expect(text).toContain(`${label}:`)
    }
  })
})
