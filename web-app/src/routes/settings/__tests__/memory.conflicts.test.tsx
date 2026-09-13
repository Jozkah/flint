/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  memoryConflicts: vi.fn(),
  memoryRecordsList: vi.fn(async () => ({ items: [], total: 0 })),
  memoryStorageSummary: vi.fn(async () => ({
    sessionCount: 0,
    projectCount: 1,
    userCount: 1,
    deletedCount: 0,
    conflictedCount: 0,
    bytes: 10,
  })),
  memorySettingsGet: vi.fn(async () => ({ automaticallySave: false, schemaVersion: 1 })),
  memorySettingsUpdate: vi.fn(),
  memoryRecordForget: vi.fn(async () => true),
  memoryRecordRestore: vi.fn(async () => true),
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
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/containers/MemoryProposalCard', () => ({ MemoryProposalList: () => null }))
vi.mock('@/hooks/useMemoryProposals', () => ({
  useMemoryProposals: () => ({
    proposals: [],
    location: null,
    reload: vi.fn(),
    onResolved: vi.fn(),
  }),
}))
vi.mock('@/hooks/useMemoryConversations', () => ({
  useMemoryConversations: () => ({
    sessions: [{ id: 's1', title: 'A session', kind: 'cowork' }],
    projects: ['/repo'],
  }),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder: async () => '/data' }) }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { Route } from '../memory'

const Page = () => {
  const Component = (Route as any).component as React.ComponentType
  return <Component />
}

const view = (id: string, content: string, scope: string) => ({
  id,
  content,
  scope,
  creator: 'user',
  origin: 'explicit',
  status: 'active',
  pinned: false,
  redacted: false,
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  useCount: 0,
  expiresAt: null,
  category: null,
  projectId: scope === 'project' ? 'proj-1' : null,
  sessionId: null,
  sourceSessionId: null,
  sourceMessageId: null,
  sourceDeleted: false,
  supersedes: null,
  preview: content,
})

const npm = view('mem-npm', 'Use npm for installs in this repository.', 'project')
const yarn = view('mem-yarn', 'Use yarn for installs everywhere.', 'user')

describe('Settings > Memory: memories that disagree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows both sides of a conflict, with where each applies', async () => {
    api.memoryConflicts.mockResolvedValue([
      { subject: 'package manager', left: npm, right: yarn },
    ])
    render(<Page />)
    const card = await screen.findByTestId('memory-conflict')
    expect(card).toHaveAttribute('data-left-id', 'mem-npm')
    expect(card).toHaveAttribute('data-right-id', 'mem-yarn')
    expect(within(card).getByText(/package manager/)).toBeInTheDocument()
    expect(within(card).getByText(npm.content)).toBeInTheDocument()
    expect(within(card).getByText(yarn.content)).toBeInTheDocument()
    // The tab is "Project" since memory can belong to a Jan project as well
    // as a folder.
    expect(within(card).getByText(/^Project/)).toBeInTheDocument()
    expect(within(card).getByText(/All conversations/)).toBeInTheDocument()
    // Asked about the place the page is looking at: the picked conversation
    // and project, never an id the page invents.
    expect(api.memoryConflicts).toHaveBeenCalledWith({
      dataFolder: '/data',
      projectRoot: '/repo',
      sessionId: 's1',
    })
  })

  it('keeping one side forgets the other, in its own scope, and the card goes', async () => {
    api.memoryConflicts
      .mockResolvedValueOnce([{ subject: 'package manager', left: npm, right: yarn }])
      .mockResolvedValue([])
    render(<Page />)
    const keep = await screen.findAllByTestId('memory-conflict-keep')
    const keepNpm = keep.find((b) => b.getAttribute('data-keep-id') === 'mem-npm')!
    expect(keepNpm).toHaveAccessibleName(/Keep "Use npm/)
    await userEvent.click(keepNpm)

    await waitFor(() =>
      expect(api.memoryRecordForget).toHaveBeenCalledWith(
        { dataFolder: '/data', projectRoot: '/repo', sessionId: 's1' },
        'user',
        'mem-yarn'
      )
    )
    // Never the kept one.
    expect(api.memoryRecordForget).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'mem-npm'
    )
    await waitFor(() => expect(screen.queryByTestId('memory-conflict')).toBeNull())
  })

  it('shows nothing when nothing disagrees', async () => {
    api.memoryConflicts.mockResolvedValue([])
    render(<Page />)
    await waitFor(() => expect(api.memoryConflicts).toHaveBeenCalled())
    expect(screen.queryByTestId('memory-conflicts')).toBeNull()
  })
})
