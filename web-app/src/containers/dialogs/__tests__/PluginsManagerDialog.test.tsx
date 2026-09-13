import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) =>
      vars ? `${k}:${JSON.stringify(vars)}` : k,
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: (
    selector: (s: { sessions: { id: string; folder: string }[]; currentId: string }) => unknown
  ) => selector({ sessions: [{ id: 's1', folder: '/project' }], currentId: 's1' }),
}))

const invalidateSkills = vi.fn()
vi.mock('@/hooks/useSkills', () => ({
  invalidateSkills: () => invalidateSkills(),
}))

const dialogOpen = vi.fn()
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ dialog: () => ({ open: dialogOpen }) }),
}))

// Mock-backed: no Tauri command runs. The command wrappers are replaced; the
// pure helpers (error mapping, URL checks) are the real implementations.
const listPlugins = vi.fn()
const getPluginDetails = vi.fn()
const getPluginSources = vi.fn()
const installPlugin = vi.fn()
const cancelPluginInstall = vi.fn()
const setPluginEnabled = vi.fn()
const removePlugin = vi.fn()
vi.mock('@/lib/pluginStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pluginStore')>()
  return {
    ...actual,
    listPlugins: (...a: unknown[]) => listPlugins(...a),
    getPluginDetails: (...a: unknown[]) => getPluginDetails(...a),
    getPluginSources: (...a: unknown[]) => getPluginSources(...a),
    installPlugin: (...a: unknown[]) => installPlugin(...a),
    cancelPluginInstall: (...a: unknown[]) => cancelPluginInstall(...a),
    setPluginEnabled: (...a: unknown[]) => setPluginEnabled(...a),
    removePlugin: (...a: unknown[]) => removePlugin(...a),
  }
})

import PluginsManagerDialog from '../PluginsManagerDialog'
import { PluginError } from '@/lib/pluginStore'
import { toast } from 'sonner'

const alpha = {
  id: 'alpha',
  name: 'alpha',
  description: 'Release helpers',
  version: '1.2.0',
  repo: '',
  skills: 2,
  commands: 1,
  agents: 1,
  enabled: true,
  sourceKind: 'local' as const,
  source: '/src/alpha',
}

const alphaDetails = {
  ...alpha,
  installedPath: '/project/.jan/agent/plugins/alpha',
  installedAtMs: 1_700_000_000_000,
  gitRef: null,
  skillNames: ['alpha:prepare', 'alpha:ship'],
  commandNames: ['release'],
  agentNames: ['alpha-reviewer'],
  hasMcpConfig: true,
  executableFiles: ['skills/prepare/scripts/run.sh'],
  executableFileCount: 1,
}

const renderDialog = async () => {
  await act(async () => {
    render(<PluginsManagerDialog open onOpenChange={vi.fn()} />)
  })
}

const openAlpha = async () => {
  await renderDialog()
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: /alpha/ }))
  })
  await screen.findByText('alpha:prepare')
}

describe('PluginsManagerDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listPlugins.mockResolvedValue([alpha])
    getPluginDetails.mockResolvedValue(alphaDetails)
    getPluginSources.mockResolvedValue({ marketplace: null, gitAvailable: true })
  })

  it('explains what a plugin is and where it applies', async () => {
    await renderDialog()
    expect(screen.getByText('plugins:whatIs')).toBeInTheDocument()
    expect(screen.getByText('plugins:whereApplies')).toBeInTheDocument()
    expect(screen.getByText('plugins:whenApplies')).toBeInTheDocument()
  })

  it('refreshes the skill list after enabling or disabling a plugin', async () => {
    setPluginEnabled.mockResolvedValue({ ...alpha, enabled: false })
    await openAlpha()
    expect(invalidateSkills).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: /plugins:toggle\.label.*alpha/ }))
    })
    await waitFor(() => expect(invalidateSkills).toHaveBeenCalledTimes(1))
  })

  it('does not refresh the skill list when the toggle is refused', async () => {
    setPluginEnabled.mockRejectedValue(new PluginError('config', 'bad toml'))
    await openAlpha()
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: /plugins:toggle\.label.*alpha/ }))
    })
    await screen.findByRole('alert')
    expect(invalidateSkills).not.toHaveBeenCalled()
  })

  it('refreshes the skill list after an install', async () => {
    installPlugin.mockResolvedValue(alpha)
    await renderDialog()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'plugins:installButton' })[0])
    })
    fireEvent.change(screen.getByLabelText('plugins:install.localPathLabel'), {
      target: { value: '/home/me/alpha' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'plugins:install.submit' }))
    })
    await waitFor(() => expect(invalidateSkills).toHaveBeenCalledTimes(1))
  })

  it('lists installed plugins with version, state, counts and source', async () => {
    await renderDialog()
    const row = await screen.findByRole('button', { name: /alpha/ })
    expect(within(row).getByText(/plugins:version.*1\.2\.0/)).toBeInTheDocument()
    expect(within(row).getByText(/plugins:state\.enabled/)).toBeInTheDocument()
    expect(
      within(row).getByText(/plugins:counts.*"skills":2.*"commands":1.*"agents":1/)
    ).toBeInTheDocument()
    expect(within(row).getByText(/plugins:source\.local: \/src\/alpha/)).toBeInTheDocument()
    expect(listPlugins).toHaveBeenCalledWith('/project')
  })

  it('shows an empty state that explains how to add a plugin', async () => {
    listPlugins.mockResolvedValue([])
    await renderDialog()
    expect(await screen.findByText('plugins:empty.title')).toBeInTheDocument()
    expect(screen.getByText('plugins:empty.body')).toBeInTheDocument()
  })

  it('shows details: components, access notes, unloaded .mcp.json and scripts', async () => {
    await openAlpha()
    expect(getPluginDetails).toHaveBeenCalledWith('/project', 'alpha')
    expect(screen.getByText('alpha:ship')).toBeInTheDocument()
    expect(screen.getByText('release')).toBeInTheDocument()
    expect(screen.getByText('alpha-reviewer')).toBeInTheDocument()
    expect(screen.getByText('/project/.jan/agent/plugins/alpha')).toBeInTheDocument()
    expect(screen.getByText('plugins:details.mcpPresent')).toBeInTheDocument()
    expect(screen.getByText('plugins:details.accessNoPermissions')).toBeInTheDocument()
    expect(screen.getByText('skills/prepare/scripts/run.sh')).toBeInTheDocument()
  })

  it('reverts the enabled switch when the backend refuses', async () => {
    let reject: (e: unknown) => void = () => {}
    setPluginEnabled.mockImplementation(
      () => new Promise((_, r) => (reject = r))
    )
    await openAlpha()
    const toggle = screen.getByRole('switch', { name: /plugins:toggle\.label.*alpha/ })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(setPluginEnabled).toHaveBeenCalledWith('/project', 'alpha', false)
    // Optimistic while pending.
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await act(async () => {
      reject(new PluginError('config', 'Failed to parse agent.toml'))
    })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('plugins:toggle.failed')
    expect(alert).toHaveTextContent('plugins:errors.config')
    expect(alert).toHaveTextContent('Failed to parse agent.toml')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('removes only after a confirmation that names what is removed', async () => {
    removePlugin.mockResolvedValue({
      id: 'alpha',
      name: 'alpha',
      removedPath: '/project/.jan/agent/plugins/alpha',
      removedFromDisabled: false,
      removedSkillEntries: ['alpha:prepare'],
    })
    await openAlpha()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'plugins:remove.button' }))
    })
    const confirm = await screen.findByRole('dialog', { name: /plugins:remove\.title/ })
    expect(
      within(confirm).getByText(/plugins:remove\.body.*\/project\/\.jan\/agent\/plugins\/alpha/)
    ).toBeInTheDocument()
    expect(within(confirm).getByText(/plugins:remove\.config/)).toBeInTheDocument()
    expect(within(confirm).getByText('plugins:remove.sourceKept')).toBeInTheDocument()
    expect(removePlugin).not.toHaveBeenCalled()

    listPlugins.mockResolvedValue([])
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'plugins:remove.confirm' }))
    })
    expect(removePlugin).toHaveBeenCalledWith('/project', 'alpha')
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    expect(invalidateSkills).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(toast.success).mock.calls[0][0])).toContain('plugins:remove.done')
  })

  it('validates the git URL field and names the host a clone contacts', async () => {
    await renderDialog()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'plugins:installButton' })[0])
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'plugins:install.git' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'plugins:install.submit' }))
    })
    const input = screen.getByLabelText('plugins:install.gitUrlLabel')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('plugins:install.errors.urlRequired')
    expect(installPlugin).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'https://git.example.org/team/plugin' } })
    expect(
      screen.getByText(/plugins:install\.gitNotice.*git\.example\.org/)
    ).toBeInTheDocument()
  })

  it('cancels a running install and reports that nothing was installed', async () => {
    let reject: (e: unknown) => void = () => {}
    installPlugin.mockImplementation(() => new Promise((_, r) => (reject = r)))
    cancelPluginInstall.mockResolvedValue(true)
    await renderDialog()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'plugins:installButton' })[0])
    })
    fireEvent.change(screen.getByLabelText('plugins:install.localPathLabel'), {
      target: { value: '/home/me/my-plugin' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'plugins:install.submit' }))
    })
    expect(installPlugin).toHaveBeenCalledTimes(1)
    const [project, source, operationId] = installPlugin.mock.calls[0]
    expect(project).toBe('/project')
    expect(source).toEqual({ kind: 'local', path: '/home/me/my-plugin' })
    expect(screen.getByText('plugins:install.copying')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'plugins:install.cancel' }))
    })
    expect(cancelPluginInstall).toHaveBeenCalledWith(operationId)
    expect(screen.getByText('plugins:install.cancelling')).toBeInTheDocument()

    await act(async () => {
      reject(new PluginError('cancelled', 'install cancelled - nothing was installed'))
    })
    expect(await screen.findByText('plugins:install.cancelled')).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('offers a marketplace source only when one is configured', async () => {
    await renderDialog()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'plugins:installButton' })[0])
    })
    expect(screen.queryByRole('radio', { name: 'plugins:install.marketplace' })).toBeNull()
  })
})
