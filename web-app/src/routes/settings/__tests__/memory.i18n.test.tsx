/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ja from '@/locales/ja/settings.json'

const api = vi.hoisted(() => ({
  memoryConflicts: vi.fn(async () => []),
  memoryRecordsList: vi.fn(async () => ({ items: [], total: 0 })),
  memoryStorageSummary: vi.fn(async () => ({
    sessionCount: 0,
    projectCount: 0,
    userCount: 2,
    deletedCount: 0,
    conflictedCount: 0,
    bytes: 10,
  })),
  memorySettingsGet: vi.fn(async () => ({ automaticallySave: false, schemaVersion: 1 })),
  memorySettingsUpdate: vi.fn(),
  memoryRecordForget: vi.fn(),
  memoryRecordRestore: vi.fn(),
  memoryRecordPin: vi.fn(),
  memoryRecordEdit: vi.fn(),
}))

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => api)
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => config,
}))
vi.mock('@/containers/SettingsMenu', () => ({ default: () => null }))
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
vi.mock('@/containers/MemoryProposalCard', () => ({ MemoryProposalList: () => null }))
vi.mock('@/hooks/useMemoryProposals', () => ({
  useMemoryProposals: () => ({ proposals: [], location: null, reload: vi.fn(), onResolved: vi.fn() }),
}))
vi.mock('@/hooks/useMemoryConversations', () => ({
  useMemoryConversations: () => ({ sessions: [], projects: [] }),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder: async () => '/data' }) }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { Route } from '../memory'
import { i18n } from '@/test/englishI18n'

const Page = () => {
  const Component = (Route as any).component as React.ComponentType
  return <Component />
}

describe('Settings > Memory is localized', () => {
  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it('shows the page chrome in the chosen language, not English', async () => {
    await i18n.changeLanguage('ja')
    render(<Page />)
    const page = ja.memoryPage
    // Toggles, tabs, buttons and the empty state come from the locale.
    expect(await screen.findByText(page.useSaved)).toBeInTheDocument()
    expect(screen.getByText(page.useFacts)).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: page.scope.chat.tab })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: page.scope.user.tab })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: page.remember })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: page.import })).toBeInTheDocument()
    expect(await screen.findByText(page.empty)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(page.newPlaceholder)).toBeInTheDocument()
    // None of the old hard-coded English survives.
    for (const english of [
      'Use saved memory in conversations',
      'Remember',
      'All conversations',
      'Nothing remembered here yet.',
      'Something Flint should remember',
    ]) {
      expect(screen.queryByText(english)).toBeNull()
    }
  })
})
