/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/hooks/useSkills', () => ({
  invalidateSkills: vi.fn(),
}))

const dialogOpen = vi.fn()
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ dialog: () => ({ open: dialogOpen }) }),
}))

const listPlugins = vi.fn()
const getPluginDetails = vi.fn()
const getPluginSources = vi.fn()
const installPlugin = vi.fn()
const removePlugin = vi.fn()
const setPluginEnabled = vi.fn()
const searchPlugins = vi.fn()

vi.mock('@/lib/pluginStore', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pluginStore')>(
    '@/lib/pluginStore'
  )
  return {
    ...actual,
    listPlugins: (...args: unknown[]) => listPlugins(...args),
    getPluginDetails: (...args: unknown[]) => getPluginDetails(...args),
    getPluginSources: (...args: unknown[]) => getPluginSources(...args),
    installPlugin: (...args: unknown[]) => installPlugin(...args),
    removePlugin: (...args: unknown[]) => removePlugin(...args),
    setPluginEnabled: (...args: unknown[]) => setPluginEnabled(...args),
    searchPlugins: (...args: unknown[]) => searchPlugins(...args),
  }
})

import PluginsTab from '../PluginsTab'

const stubPlugin = {
  id: 'demo-plugin',
  name: 'Demo Plugin',
  description: 'A demo plugin',
  version: '1.0.0',
  repo: 'demo/repo',
  skills: 1,
  commands: 0,
  agents: 0,
  enabled: true,
  sourceKind: 'local' as const,
  source: '/path/to/demo',
}

describe('PluginsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listPlugins.mockResolvedValue([stubPlugin])
    getPluginDetails.mockResolvedValue({
      ...stubPlugin,
      installedPath: '/path/to/demo',
      installedAtMs: null,
      gitRef: null,
      skillNames: [],
      commandNames: [],
      agentNames: [],
      hasMcpConfig: false,
      executableFiles: [],
      executableFileCount: 0,
    })
    searchPlugins.mockResolvedValue([
      { name: 'market-plugin', description: 'From the marketplace', repo: 'org/repo', ref: null },
    ])
  })

  it('lists a stubbed global plugin from listPlugins(scope: global)', async () => {
    getPluginSources.mockResolvedValue({ marketplace: null, gitAvailable: true })
    render(<PluginsTab />)

    await waitFor(() => {
      expect(listPlugins).toHaveBeenCalledWith('', 'global')
    })
    expect(await screen.findByText('Demo Plugin')).toBeInTheDocument()
  })

  it('with a configured global marketplace, Browse renders results and searchPlugins is called with global scope', async () => {
    getPluginSources.mockResolvedValue({
      marketplace: 'https://example.com/index.json',
      gitAvailable: true,
    })
    render(<PluginsTab />)
    await waitFor(() => expect(listPlugins).toHaveBeenCalled())
    await waitFor(() => expect(getPluginSources).toHaveBeenCalledWith('', 'global'))

    fireEvent.click(screen.getByTestId('plugins-browse-button'))

    await waitFor(() => {
      expect(searchPlugins).toHaveBeenCalledWith(expect.any(String), 'global')
    })
    expect(await screen.findByText('market-plugin')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-browse-unconfigured')).not.toBeInTheDocument()
  })

  it('with no global marketplace configured, Browse shows an honest configure-it state and never calls searchPlugins', async () => {
    getPluginSources.mockResolvedValue({ marketplace: null, gitAvailable: true })
    render(<PluginsTab />)
    await waitFor(() => expect(listPlugins).toHaveBeenCalled())
    await waitFor(() => expect(getPluginSources).toHaveBeenCalledWith('', 'global'))

    fireEvent.click(screen.getByTestId('plugins-browse-button'))

    expect(await screen.findByTestId('plugins-browse-unconfigured')).toBeInTheDocument()
    expect(searchPlugins).not.toHaveBeenCalled()
    expect(screen.queryByText('market-plugin')).not.toBeInTheDocument()
  })

  it('install-by-source (local/git/marketplace name) is available regardless of marketplace configuration', async () => {
    getPluginSources.mockResolvedValue({ marketplace: null, gitAvailable: true })
    render(<PluginsTab />)
    await waitFor(() => expect(listPlugins).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('plugins-install-button'))
    expect(screen.getByText('plugins:install.title')).toBeInTheDocument()
    // Local and git radio options are present and usable without a marketplace.
    expect(screen.getByLabelText('plugins:install.local')).toBeInTheDocument()
    expect(screen.getByLabelText('plugins:install.git')).toBeInTheDocument()
    expect(screen.getByLabelText('plugins:install.marketplace')).toBeInTheDocument()
  })
})
