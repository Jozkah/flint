/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'

import { vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({ ...config, id: '/extensions' }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/components/shell/HeaderSlot', () => ({
  useHeaderSlot: () => null,
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: any) => (
    <div data-testid="context-bar">{children}</div>
  ),
}))

// PluginsTab pulls in useSkills, which resolves to the unbuilt
// `@janhq/tauri-plugin-agent-tools-api` package outside a Tauri build; stub
// it so this route test doesn't need that package.
vi.mock('@/hooks/useSkills', () => ({
  invalidateSkills: vi.fn(),
}))

vi.mock('@/lib/skillStore', () => ({
  storeScope: { kind: 'store' },
  projectScope: (folder: string) => ({ kind: 'project', folder }),
  isPluginSkill: () => false,
  listSkills: vi.fn().mockResolvedValue([]),
  readSkill: vi.fn(),
  writeSkill: vi.fn(),
  deleteSkill: vi.fn(),
}))

vi.mock('@/lib/extensionsStore', () => ({
  listProjects: vi.fn().mockResolvedValue([]),
  getMatrix: vi.fn().mockResolvedValue({ skills: {}, plugins: {} }),
  ccScan: vi.fn().mockResolvedValue({ items: [] }),
  ccImport: vi.fn(),
}))

vi.mock('@/lib/pluginStore', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pluginStore')>(
    '@/lib/pluginStore'
  )
  return {
    ...actual,
    listPlugins: vi.fn().mockResolvedValue([]),
    getPluginSources: vi.fn().mockResolvedValue({ marketplace: null, gitAvailable: true }),
  }
})

import { Route } from '../extensions'

const renderComponent = () => {
  const Component = Route.component as React.ComponentType
  return render(<Component />)
}

describe('ExtensionsPage route', () => {
  it('renders both the Plugins and Skills tabs', () => {
    renderComponent()
    expect(screen.getByTestId('extensions-tab-plugins')).toHaveTextContent(
      'common:extensionsManager.plugins'
    )
    expect(screen.getByTestId('extensions-tab-skills')).toHaveTextContent(
      'common:extensionsManager.skills'
    )
  })

  it('defaults to the plugins panel and switches to skills on click', () => {
    renderComponent()
    expect(screen.getByTestId('extensions-panel-plugins')).toBeInTheDocument()
    expect(
      screen.queryByTestId('extensions-panel-skills')
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('extensions-tab-skills'))
    expect(screen.getByTestId('extensions-panel-skills')).toBeInTheDocument()
    expect(
      screen.queryByTestId('extensions-panel-plugins')
    ).not.toBeInTheDocument()
  })

  it('opens the Import from Claude Code dialog from its header button', () => {
    renderComponent()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('extensions-import-cc-button'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
