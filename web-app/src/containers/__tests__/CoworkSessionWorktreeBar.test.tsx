import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k}#${Object.values(opts).join(',')}` : k,
  }),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    app: () => ({ getJanDataFolder: async () => '/data' }),
    opener: () => ({ openPath: vi.fn() }),
  }),
}))

import { CoworkSessionWorktreeBar } from '../CoworkSessionWorktreeBar'
import type { WorktreeRecord } from '@/hooks/useCoworkWorktrees'

const paths = Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`)

const record = (uncommitted: string[]): WorktreeRecord => ({
  path: '/data/worktrees/ab/cd',
  branch: 'flint/a-very-long-branch-name-for-this-session-0123456789',
  baseSha: 'a'.repeat(40),
  sourceRoot: '/repo',
  identity: { root: '/repo', firstCommit: 'b'.repeat(40) },
  uncommittedAtCreation: uncommitted,
  baseBranch: 'main',
})

const bar = (rec: WorktreeRecord | undefined, sessionId = 's1') => (
  <CoworkSessionWorktreeBar
    sessionId={sessionId}
    title="t"
    folder="/repo"
    record={rec}
    offerCopy={false}
    onWorkOnCopy={async () => {}}
    onCreatePr={() => {}}
    onDiscarded={() => {}}
  />
)

describe('the session worktree bar', () => {
  beforeEach(() => localStorage.clear())

  it('is not shown before the session has a worktree', () => {
    render(bar(undefined))
    expect(screen.queryByTestId('session-worktree-bar')).toBeNull()
  })

  it('fades the branch name and keeps it in a tooltip', () => {
    render(bar(record([])))
    const branch = screen.getByTestId('session-worktree-branch')
    expect(branch).toHaveClass('text-fade')
    expect(branch.getAttribute('title')).toContain('a-very-long-branch-name')
  })

  it('says what was not carried over in one line, with at most 20 paths behind Details', async () => {
    render(bar(record(paths)))
    const line = screen.getByTestId('worktree-not-carried')
    expect(line).toHaveTextContent('common:coworkParallel.notCarriedCount#25')
    expect(line).not.toHaveTextContent('src/file-0.ts')

    await userEvent.click(
      screen.getByText('common:coworkParallel.notCarriedDetails')
    )
    const list = await screen.findByTestId('worktree-not-carried-list')
    expect(list.querySelectorAll('li')).toHaveLength(20)
    expect(
      screen.getByText('common:coworkParallel.notCarriedMore#5,5')
    ).toBeInTheDocument()
  })

  it('stays dismissed for the session', async () => {
    const { unmount } = render(bar(record(paths)))
    await userEvent.click(
      screen.getByLabelText('common:coworkParallel.notCarriedDismiss')
    )
    expect(screen.queryByTestId('worktree-not-carried')).toBeNull()
    unmount()

    render(bar(record(paths)))
    expect(screen.queryByTestId('worktree-not-carried')).toBeNull()
    render(bar(record(paths), 's2'))
    expect(screen.getByTestId('worktree-not-carried')).toBeInTheDocument()
  })
})
