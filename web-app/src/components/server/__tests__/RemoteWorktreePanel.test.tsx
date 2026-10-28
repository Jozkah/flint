import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { RemoteWorktreePanel } from '../RemoteWorktreePanel'
import { useRemoteWorktrees } from '@/lib/remoteWorktree'
import { useCoworkRun } from '@/hooks/useCoworkRun'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

const api = vi.hoisted(() => ({
  worktreeState: vi.fn(),
  worktreePending: vi.fn(),
  worktreeUnmerged: vi.fn(),
  commitWorktree: vi.fn(),
  mergeWorktree: vi.fn(),
  discardWorktree: vi.fn(),
  listProposals: vi.fn(),
}))

vi.mock('@/lib/remoteRunner', () => ({
  worktreeState: api.worktreeState,
  worktreePending: api.worktreePending,
  worktreeUnmerged: api.worktreeUnmerged,
  commitWorktree: api.commitWorktree,
  mergeWorktree: api.mergeWorktree,
  discardWorktree: api.discardWorktree,
}))
vi.mock('@/lib/proposals', () => ({ listProposals: api.listProposals }))
vi.mock('@/containers/CoworkProposalReview', () => ({
  CoworkProposalReview: (props: { worktree: { path: string; sourceRoot: string } }) => (
    <div data-testid="review">
      {props.worktree.path}|{props.worktree.sourceRoot}
    </div>
  ),
}))

const SID = 's1'
const wt = {
  path: '/data/worktrees/ab/cd',
  branch: 'flint/fix-1',
  baseBranch: 'main',
  baseSha: 'a'.repeat(40),
  sourceRoot: '/srv/app',
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  useRemoteWorktrees.setState({ ticks: {}, proposals: {}, errors: {} })
  useCoworkRun.setState({ liveTurns: {}, runs: {}, outcomes: {}, pendingAsks: {}, usage: {} })
  api.worktreeState.mockResolvedValue({ state: 'ready', worktree: wt, project: '/srv/app' })
  api.worktreePending.mockResolvedValue(['out.txt'])
  api.worktreeUnmerged.mockResolvedValue([])
  api.listProposals.mockResolvedValue([])
})

describe('RemoteWorktreePanel', () => {
  it('renders nothing for a session without a worktree', async () => {
    api.worktreeState.mockRejectedValue(new Error('that session has no worktree'))
    const { container } = render(<RemoteWorktreePanel sessionId={SID} />)
    await waitFor(() => expect(api.worktreeState).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="remote-worktree"]')).toBeNull()
  })

  it('shows the branch, state and counts, and merges after committing pending work', async () => {
    api.mergeWorktree.mockResolvedValue({
      merged: true,
      fastForward: true,
      alreadyMerged: false,
      target: 'main',
      newTip: 'x',
      conflicts: [],
      committedPending: true,
    })
    render(<RemoteWorktreePanel sessionId={SID} />)
    expect(await screen.findByTestId('remote-worktree-branch')).toHaveTextContent('flint/fix-1')
    expect(screen.getByTestId('remote-worktree-state')).toHaveTextContent('ready')
    expect(screen.getByTestId('remote-worktree-counts')).toHaveTextContent('1 uncommitted, 0 to merge')
    fireEvent.click(screen.getByTestId('remote-worktree-merge'))
    await waitFor(() => expect(api.mergeWorktree).toHaveBeenCalledWith(SID))
    expect(api.commitWorktree).toHaveBeenCalledWith(SID, expect.any(String))
    expect(await screen.findByTestId('remote-worktree-message')).toHaveTextContent('Merged into main')
  })

  it('reports conflicts and leaves the choice with the person', async () => {
    api.mergeWorktree.mockResolvedValue({
      merged: false,
      fastForward: false,
      alreadyMerged: false,
      target: 'main',
      newTip: null,
      conflicts: ['a.txt'],
      committedPending: false,
    })
    render(<RemoteWorktreePanel sessionId={SID} />)
    fireEvent.click(await screen.findByTestId('remote-worktree-merge'))
    expect(await screen.findByTestId('remote-worktree-error')).toHaveTextContent('conflicts in a.txt')
  })

  it('asks before discarding and then discards with the list in view', async () => {
    api.discardWorktree.mockResolvedValue({ discarded: true })
    render(<RemoteWorktreePanel sessionId={SID} />)
    fireEvent.click(await screen.findByTestId('remote-worktree-discard'))
    expect(api.discardWorktree).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('remote-worktree-discard-confirm'))
    await waitFor(() => expect(api.discardWorktree).toHaveBeenCalledWith(SID, true))
  })

  it('offers the review only for a pending proposal of this session and worktree', async () => {
    api.listProposals.mockResolvedValue([
      { id: 'other', state: 'pending', scope: { session: 'x', worktree: wt.path }, files: [] },
      {
        id: 'p1',
        state: 'pending',
        scope: { session: SID, worktree: wt.path },
        files: [{ path: 'out.txt' }],
      },
    ])
    render(<RemoteWorktreePanel sessionId={SID} />)
    expect(await screen.findByTestId('remote-worktree-proposal')).toHaveTextContent('out.txt')
    expect(screen.getByTestId('review')).toHaveTextContent(wt.path + '|/srv/app')
  })

  it('disables merge and discard while a turn runs', async () => {
    useCoworkRun.setState({ runs: { [SID]: { runId: 'r' } } } as never)
    render(<RemoteWorktreePanel sessionId={SID} />)
    expect(await screen.findByTestId('remote-worktree-merge')).toBeDisabled()
    expect(screen.getByTestId('remote-worktree-discard')).toBeDisabled()
  })
})
