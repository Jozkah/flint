import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const search = vi.hoisted(() => ({ value: {} as { tab?: string } }))
const platform = vi.hoisted(() => ({ tauri: true }))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: Record<string, unknown>) => ({
    ...config,
    options: config,
    useSearch: () => search.value,
  }),
}))
vi.mock('@/lib/platform/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/utils')>()),
  isPlatformTauri: () => platform.tauri,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/containers/SettingsPageHeader', () => ({
  SettingsPageHeader: () => null,
  SettingsPageBody: ({
    title,
    actions,
    children,
  }: {
    title: string
    actions?: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      <h2>{title}</h2>
      <div data-testid="actions">{actions}</div>
      {children}
    </div>
  ),
}))
vi.mock('@/containers/ClaudeCodeSettings', () => ({
  ClaudeCodeSettings: () => <div data-testid="claude-code-tab" />,
}))
vi.mock('@/containers/ExtensionsSettings', () => ({
  ExtensionsSettings: () => <div data-testid="extensions-tab" />,
}))
vi.mock('@/containers/JevSettingsCard', () => ({
  JevSettingsCard: ({ anchors }: { anchors: { key: string } }) => (
    <div data-testid="jev-tab" data-anchor={anchors.key} />
  ),
}))

import { Route } from '../integrations'

const Page = (Route as unknown as { component: React.ComponentType }).component

describe('Settings > Integrations', () => {
  beforeEach(() => {
    search.value = {}
    platform.tauri = true
  })

  it('opens on Claude Code with a strip of three tabs', () => {
    render(<Page />)
    expect(screen.getByText('common:integrations')).toBeInTheDocument()
    expect(screen.getByTestId('claude-code-tab')).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  it('opens the tab the URL names', () => {
    search.value = { tab: 'extensions' }
    render(<Page />)
    expect(screen.getByTestId('extensions-tab')).toBeInTheDocument()
    expect(screen.queryByTestId('claude-code-tab')).toBeNull()
  })

  it('switches tabs from the strip', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('radio', { name: /common:jev.tab/ }))
    expect(screen.getByTestId('jev-tab')).toHaveAttribute(
      'data-anchor',
      'settings-integrations-jev-key'
    )
  })

  it('shows only Jev, without a strip, outside the desktop app', () => {
    platform.tauri = false
    search.value = { tab: 'claude-code' }
    render(<Page />)
    expect(screen.getByTestId('jev-tab')).toBeInTheDocument()
    expect(screen.queryByTestId('claude-code-tab')).toBeNull()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
  })

  it('accepts only known tabs in the URL', () => {
    const validate = (
      Route as unknown as {
        options: { validateSearch: (s: object) => object }
      }
    ).options.validateSearch
    expect(validate({ tab: 'jev' })).toEqual({ tab: 'jev' })
    expect(validate({ tab: 'nope' })).toEqual({})
  })
})
