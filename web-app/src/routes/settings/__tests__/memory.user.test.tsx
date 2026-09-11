/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const RECALL_ON = { session: true, project: true, user: true }

const api = vi.hoisted(() => ({
  memoryConflicts: vi.fn(async () => [] as any[]),
  memoryRecordsList: vi.fn(async () => ({ items: [] as any[], total: 0 })),
  memoryStorageSummary: vi.fn(async () => ({
    sessionCount: 0,
    projectCount: 0,
    userCount: 1,
    deletedCount: 0,
    conflictedCount: 0,
    bytes: 10,
    issues: [] as string[],
  })),
  memorySettingsGet: vi.fn(async () => ({
    automaticallySave: false,
    recall: { session: true, project: true, user: true },
    schemaVersion: 1,
    issue: null as string | null,
  })),
  memorySettingsUpdate: vi.fn(async (_l: any, change: any) => ({
    automaticallySave: false,
    recall: change.recall,
    schemaVersion: 1,
    issue: null,
  })),
  memoryRecordPropose: vi.fn(async (_l: any, scope: any, content: string) => ({
    content,
    scope,
    contentHash: 'hash-1',
    duplicates: [],
    conflicts: [],
    redacted: false,
  })),
  memoryRecordCommit: vi.fn(async () => ({})),
  memoryScopeClear: vi.fn(async () => 2),
  memoryRecordForget: vi.fn(async () => true),
  memoryRecordRestore: vi.fn(async () => true),
  memoryRecordPin: vi.fn(),
  memoryRecordEdit: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => api)
vi.mock('sonner', () => ({ toast }))
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
  useMemoryProposals: () => ({ proposals: [], location: null, reload: vi.fn(), onResolved: vi.fn() }),
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

import { Route } from '../memory'

const Page = () => {
  const Component = (Route as any).component as React.ComponentType
  return <Component />
}
const LOCATION = { dataFolder: '/data', projectRoot: '/repo', sessionId: 's1' }

describe('Settings > Memory: user memory controls (AH-082)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the stored recall switches and turns one scope off without touching the others', async () => {
    api.memorySettingsGet.mockResolvedValueOnce({
      automaticallySave: false,
      recall: { session: true, project: true, user: true },
      schemaVersion: 1,
      issue: null,
    })
    render(<Page />)
    const user = await screen.findByTestId('memory-recall-user')
    await waitFor(() => expect(user).toHaveAttribute('data-checked', 'true'))
    await userEvent.click(user)
    await waitFor(() =>
      expect(api.memorySettingsUpdate).toHaveBeenCalledWith(LOCATION, {
        recall: { ...RECALL_ON, user: false },
      })
    )
    await waitFor(() => expect(user).toHaveAttribute('data-checked', 'false'))
    expect(screen.getByTestId('memory-recall-off-note')).toBeInTheDocument()
    // Records are only withheld: nothing was forgotten.
    expect(api.memoryRecordForget).not.toHaveBeenCalled()
    expect(api.memoryScopeClear).not.toHaveBeenCalled()
  })

  it('puts a rejected recall change back and says so', async () => {
    api.memorySettingsUpdate.mockRejectedValueOnce(new Error('disk full'))
    render(<Page />)
    const user = await screen.findByTestId('memory-recall-user')
    await waitFor(() => expect(user).toHaveAttribute('data-checked', 'true'))
    await userEvent.click(user)
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(user).toHaveAttribute('data-checked', 'true')
  })

  it('shows damaged storage and damaged settings as an error, not as an empty store', async () => {
    api.memoryStorageSummary.mockResolvedValueOnce({
      sessionCount: 0,
      projectCount: 0,
      userCount: 0,
      deletedCount: 0,
      conflictedCount: 0,
      bytes: 0,
      issues: ['user.jsonl: 1 damaged record(s) were skipped'],
    })
    api.memorySettingsGet.mockResolvedValueOnce({
      automaticallySave: false,
      recall: { session: false, project: false, user: false },
      schemaVersion: 1,
      issue: 'memory settings are damaged; recall is off until they are saved again',
    })
    render(<Page />)
    const alert = await screen.findByTestId('memory-storage-error')
    expect(alert).toHaveTextContent('damaged record')
    expect(alert).toHaveTextContent('recall is off')
    expect(alert).toHaveAttribute('role', 'alert')
  })

  it('saves a memory the user writes, in the tab scope, committing exactly what was proposed', async () => {
    render(<Page />)
    const box = await screen.findByTestId('memory-new-content')
    await userEvent.type(box, 'The user signs off as Quill.')
    await userEvent.click(screen.getByTestId('memory-new-save'))
    await waitFor(() =>
      expect(api.memoryRecordCommit).toHaveBeenCalledWith(
        LOCATION,
        'user',
        'The user signs off as Quill.',
        'hash-1',
        undefined
      )
    )
    expect(api.memoryRecordPropose).toHaveBeenCalledWith(
      LOCATION,
      'user',
      'The user signs off as Quill.',
      undefined
    )
  })

  it('forgets a whole scope only after confirmation', async () => {
    api.memoryRecordsList.mockResolvedValue({
      items: [
        {
          id: 'mem-1',
          content: 'x',
          preview: 'x',
          scope: 'user',
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
          projectId: null,
          sessionId: null,
          sourceSessionId: null,
          sourceMessageId: null,
          sourceDeleted: false,
          supersedes: null,
        },
      ],
      total: 1,
    })
    render(<Page />)
    const clear = await screen.findByTestId('memory-clear-scope')
    await waitFor(() => expect(clear).not.toBeDisabled())
    await userEvent.click(clear)
    expect(api.memoryScopeClear).not.toHaveBeenCalled()
    await userEvent.click(await screen.findByTestId('memory-clear-confirm'))
    await waitFor(() => expect(api.memoryScopeClear).toHaveBeenCalledWith(LOCATION, 'user'))
  })

  it('shows provenance: version or unknown, source, history and the snapshots it was used in (AH-083)', async () => {
    const base = {
      content: 'x',
      preview: 'x',
      scope: 'user',
      creator: 'user',
      origin: 'explicit',
      status: 'active',
      pinned: false,
      redacted: false,
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 5,
      useCount: 1,
      expiresAt: null,
      category: null,
      projectId: null,
      sessionId: null,
      sourceSessionId: 's1',
      sourceMessageId: null,
      sourceDeleted: false,
      supersedes: null,
    }
    api.memoryRecordsList.mockResolvedValue({
      items: [
        {
          ...base,
          id: 'mem-new',
          version: 2,
          contentHash: 'h2',
          sourceType: 'user-authored',
          sourceRunId: 'run-9',
          sourceProjectId: 'proj-1',
          history: [{ version: 1, content_hash: 'h1', replaced_at: 3 }],
          uses: [{ session_id: 's1', turn_id: 'turn-snap-7', snapshot_id: 'snap-7', reason: 'applies to this user', at: 5 }],
        },
        { ...base, id: 'mem-old', version: null, history: [], uses: [] },
      ],
      total: 2,
    })
    render(<Page />)
    const versions = await screen.findAllByTestId('memory-provenance-version')
    expect(versions[0]).toHaveTextContent('2')
    expect(versions[1]).toHaveTextContent('unknown')
    expect(screen.getAllByTestId('memory-provenance-source')[0]).toHaveTextContent('user-authored')
    expect(screen.getByTestId('memory-provenance-history')).toHaveTextContent('v1 · h1')
    const uses = screen.getAllByTestId('memory-provenance-uses')
    expect(uses[0].querySelector('[data-snapshot-id="snap-7"]')).not.toBeNull()
    expect(uses[1]).toHaveTextContent('no recorded request yet')
  })

  it('undo of a settled conflict hands the forgotten text back, which the store now needs', async () => {
    const view = (id: string, content: string, scope: string) => ({
      id,
      content,
      preview: content,
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
      projectId: null,
      sessionId: null,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceDeleted: false,
      supersedes: null,
    })
    api.memoryConflicts.mockResolvedValueOnce([
      {
        subject: 'package manager',
        left: view('mem-npm', 'Use npm.', 'project'),
        right: view('mem-yarn', 'Use yarn.', 'user'),
      },
    ])
    render(<Page />)
    const keep = (await screen.findAllByTestId('memory-conflict-keep')).find(
      (b) => b.getAttribute('data-keep-id') === 'mem-npm'
    )!
    await userEvent.click(keep)
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const undo = (toast.success.mock.calls[0][1] as any).action.onClick
    undo()
    await waitFor(() =>
      expect(api.memoryRecordRestore).toHaveBeenCalledWith(LOCATION, 'user', 'mem-yarn', 'Use yarn.')
    )
  })
})
