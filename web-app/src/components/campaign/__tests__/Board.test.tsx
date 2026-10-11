import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import { CampaignBoard } from '../Board'
import { useCampaignStore } from '@/hooks/useCampaigns'
import type { Campaign, CampaignTask } from '@/lib/campaignModel'
import type { BoardActions } from '@/lib/campaignBoardActions'

const task = (id: string, over: Partial<CampaignTask> = {}): CampaignTask => ({
  id,
  title: `Task ${id}`,
  brief: '',
  acceptance: [],
  paths: [],
  dependsOn: [],
  status: 'pending',
  attempt: 0,
  tokensUsed: 1234,
  detail: '',
  ...over,
})

const campaign = (tasks: CampaignTask[], over: Partial<Campaign> = {}): Campaign => ({
  schemaVersion: 1,
  id: 'c1',
  title: 'Ship it',
  coordinatorSession: 'coord',
  sourceRoot: '/repo',
  baseBranch: 'main',
  baseSha: 'abc',
  integrationBranch: 'flint/campaign-c1',
  integrationWorktree: '/w',
  modeCeiling: 'auto',
  model: '',
  limits: { maxParallel: 4, maxTasks: 12 },
  status: 'running',
  processEpoch: 'e',
  createdAt: '',
  updatedAt: '',
  tasks,
  ...over,
})

const actions = {
  pause: vi.fn(async () => ({ ok: true })),
  resume: vi.fn(async () => ({ ok: true })),
} as unknown as BoardActions

const load = () =>
  Promise.resolve({
    files: [],
    added: 0,
    removed: 0,
    truncated: false,
    uncommitted: false,
  })

const show = (c: Campaign) => {
  useCampaignStore.setState({ campaigns: [c], loaded: true })
  // The store is read through a poller; no backend here, so keep it quiet.
  return render(
    <CampaignBoard
      campaignId={c.id}
      actions={actions}
      loadDiff={load}
      loadSummary={load}
    />
  )
}

describe('CampaignBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(useCampaignStore.getState(), 'refresh').mockResolvedValue()
  })

  it('leads with a plain sentence, a progress bar and one button', () => {
    show(
      campaign([
        task('a', { status: 'merged' }),
        task('b', { status: 'running', sessionId: 's-b', worktreePath: '/w/b' }),
        task('c', { status: 'pending', dependsOn: ['b'] }),
      ])
    )
    expect(screen.getByTestId('campaign-headline')).toHaveTextContent(
      'Working: 1 of 3 tasks done'
    )
    expect(screen.getByTestId('campaign-primary')).toHaveTextContent('Pause')
    expect(screen.getByTestId('campaign-progress')).toBeInTheDocument()
    // The raw token string stays out of sight until Details is opened.
    expect(screen.queryByTestId('campaign-budget')).toBeNull()
    // The board's own Details comes last, after each row's.
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' }).at(-1)!)
    expect(screen.getByTestId('campaign-budget')).toBeInTheDocument()
  })

  it('groups tasks under plain headings and only shows groups that hold something', () => {
    show(
      campaign([
        task('a', { status: 'merged' }),
        task('b', { status: 'running' }),
        task('c', { status: 'pending', dependsOn: ['b'] }),
      ])
    )
    expect(screen.getByTestId('campaign-section-working')).toBeInTheDocument()
    expect(screen.getByTestId('campaign-section-up-next')).toBeInTheDocument()
    expect(screen.getByTestId('campaign-section-done')).toBeInTheDocument()
    expect(screen.queryByTestId('campaign-section-needs-you')).toBeNull()
    expect(screen.getByTestId('campaign-task-word-c')).toHaveTextContent(
      'Waiting for Task b'
    )
    expect(screen.getByTestId('campaign-task-word-b')).toHaveTextContent(
      'Writing code'
    )
  })

  it('puts a failed task under Needs you with Retry and Skip', () => {
    show(campaign([task('a', { status: 'failed', detail: 'tests failed' })]))
    expect(screen.getByTestId('campaign-headline')).toHaveTextContent(
      'Needs your attention: 1 task is waiting for you'
    )
    const section = screen.getByTestId('campaign-section-needs-you')
    expect(section).toHaveTextContent('Retry')
    expect(section).toHaveTextContent('Skip')
    expect(section).toHaveTextContent('tests failed')
  })

  it('shows a planning state while there are no tasks', () => {
    show(campaign([], { status: 'approved' }))
    expect(screen.getByTestId('campaign-empty')).toHaveTextContent('Planning')
    expect(screen.queryByTestId('campaign-progress')).toBeNull()
  })

  it('matches the button to the state: Resume when paused', () => {
    show(campaign([task('a', { status: 'queued' })], { status: 'paused' }))
    const primary = screen.getByTestId('campaign-primary')
    expect(primary).toHaveTextContent('Resume')
    fireEvent.click(primary)
    expect(actions.resume).toHaveBeenCalledWith('c1')
  })
})
