/**
 * The review list for a team's isolated children. AH-109.
 *
 * What it must never do: show an unfinished child as a clean one, open a
 * review of a worktree that is gone or holds a link out of itself, or make a
 * child's proposal from anything but the backend's own record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}))

import { CoworkTeamReviews } from '../CoworkTeamReviews'
import type { ChildView } from '@/lib/teamChildren'

const base = (over: Partial<ChildView>): ChildView => ({
  ownerId: 's1--child-alpha',
  parentSession: 's1',
  run: 'r1',
  call: 'c1',
  taskId: 'alpha',
  description: 'rewrite the header',
  agent: 'worker',
  worktreePath: 'C:/data/worktrees/k/alpha',
  branch: 'jan/cowork/s1childalpha-00ff',
  baseSha: '0123456789abcdef0123456789abcdef01234567',
  sourceRoot: 'C:/project',
  status: 'completed',
  detail: '',
  startedAt: '2026-09-11T10:00:00Z',
  endedAt: '2026-09-11T10:01:00Z',
  declaredWrites: ['team-target.txt'],
  overrides: [],
  state: 'completed',
  files: [
    {
      path: 'team-target.txt',
      change: 'modified',
      additions: 2,
      deletions: 2,
      binary: false,
    },
  ],
  problem: null,
  ...over,
})

const children: ChildView[] = [
  base({}),
  base({
    ownerId: 's1--child-gamma',
    taskId: 'gamma',
    worktreePath: 'C:/data/worktrees/k/gamma',
    status: 'failed',
    state: 'failed',
    problem: {
      kind: 'incomplete',
      message: 'task gamma failed; what it changed is not a finished result',
    },
  }),
  base({
    ownerId: 's1--child-delta',
    taskId: 'delta',
    worktreePath: 'C:/data/worktrees/k/delta',
    files: [],
    problem: { kind: 'deleted', message: 'C:/data/worktrees/k/delta no longer exists' },
  }),
  base({
    ownerId: 's1--child-eps',
    taskId: 'eps',
    worktreePath: 'C:/data/worktrees/k/eps',
    problem: { kind: 'link-escape', message: 'escape is a link' },
  }),
]

const row = (task: string) =>
  screen
    .getAllByTestId('team-child')
    .find((el) => el.getAttribute('data-task') === task)!

describe('CoworkTeamReviews', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'agent_team_children_list') return children
      if (cmd === 'agent_proposal_list') return []
      if (cmd === 'agent_team_child_propose') {
        throw { message: 'the worktree changed', conflicts: [], kind: 'modified-after-finish' }
      }
      return null
    })
  })

  it('identifies each child: task, branch, base, worktree, files and ending', async () => {
    render(<CoworkTeamReviews project="C:/project" session="s1" />)
    await waitFor(() => expect(screen.getAllByTestId('team-child')).toHaveLength(4))
    expect(invoke).toHaveBeenCalledWith('agent_team_children_list', {
      project: 'C:/project',
      session: 's1',
    })
    const alpha = row('alpha')
    expect(within(alpha).getByTestId('team-child-state').textContent).toBe('Completed')
    expect(within(alpha).getByTestId('team-child-branch').textContent).toContain('jan/cowork/')
    expect(within(alpha).getByTestId('team-child-base').textContent).toContain('0123456789')
    expect(within(alpha).getByTestId('team-child-worktree').textContent).toBe(
      'C:/data/worktrees/k/alpha'
    )
    expect(within(alpha).getByTestId('team-child-file').textContent).toContain('+2')
    expect(within(alpha).getByTestId('team-child-review')).toBeEnabled()
  })

  it('keeps a failed child’s review shut until the person has read why', async () => {
    render(<CoworkTeamReviews project="C:/project" session="s1" />)
    await waitFor(() => expect(screen.getAllByTestId('team-child')).toHaveLength(4))
    const gamma = row('gamma')
    expect(within(gamma).getByTestId('team-child-state').textContent).toBe('Failed')
    expect(within(gamma).getByRole('alert').textContent).toContain('failed')
    const review = within(gamma).getByTestId('team-child-review')
    expect(review).toBeDisabled()
    await userEvent.click(within(gamma).getByTestId('team-child-acknowledge'))
    expect(review).toBeEnabled()
    await userEvent.click(review)
    await userEvent.click(within(gamma).getByTestId('proposal-create'))
    // The proposal is asked for by child identity, with the acknowledgement,
    // and never with a path.
    expect(invoke).toHaveBeenCalledWith('agent_team_child_propose', {
      parentSession: 's1',
      taskId: 'gamma',
      acknowledge: true,
    })
    expect((await within(gamma).findByTestId('proposal-error')).textContent).toContain(
      'the worktree changed'
    )
  })

  it('cannot open a review of a worktree that is gone or links out of itself', async () => {
    render(<CoworkTeamReviews project="C:/project" session="s1" />)
    await waitFor(() => expect(screen.getAllByTestId('team-child')).toHaveLength(4))
    for (const task of ['delta', 'eps']) {
      const el = row(task)
      expect(within(el).getByTestId('team-child-review')).toBeDisabled()
      expect(within(el).queryByTestId('team-child-acknowledge')).toBeNull()
      expect(within(el).getByTestId('team-child-problem').getAttribute('data-kind')).toBe(
        task === 'delta' ? 'deleted' : 'link-escape'
      )
    }
  })

  it('says when a pair ran side by side at the person’s decision', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'agent_team_children_list')
        return [
          base({
            overrides: [
              {
                tasks: ['alpha', 'beta'],
                paths: ['team-target.txt'],
                decidedAt: '2026-09-11T10:00:00Z',
              },
            ],
          }),
        ]
      return []
    })
    render(<CoworkTeamReviews project="C:/project" session="s1" />)
    expect((await screen.findByTestId('team-child-override')).textContent).toContain(
      'beta'
    )
  })

  it('shows nothing when no child ran in a checkout of its own', async () => {
    invoke.mockImplementation(async () => [])
    render(<CoworkTeamReviews project="C:/project" session="s1" />)
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(screen.queryByTestId('team-reviews')).toBeNull()
  })
})
