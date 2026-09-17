/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/hooks/useSkills', () => ({
  invalidateSkills: vi.fn(),
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
    getPluginSources.mockResolvedValue({ marketplace: 'https://example.com/index.json', gitAvailable: true })
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
    render(<PluginsTab />)

    await waitFor(() => {
      expect(listPlugins).toHaveBeenCalledWith('', 'global')
    })
    expect(await screen.findByText('Demo Plugin')).toBeInTheDocument()
  })

  it('calls searchPlugins when the Browse action is used', async () => {
    render(<PluginsTab />)
    await waitFor(() => expect(listPlugins).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('plugins-browse-button'))

    await waitFor(() => {
      expect(searchPlugins).toHaveBeenCalled()
    })
    expect(await screen.findByText('market-plugin')).toBeInTheDocument()
  })
})
