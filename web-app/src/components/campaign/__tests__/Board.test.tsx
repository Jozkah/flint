import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  retryTask: vi.fn(async () => ({ ok: true })),
  verifyAgain: vi.fn(async () => ({ ok: true })),
  acceptAnyway: vi.fn(async () => ({ ok: true })),
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

const show = (
  c: Campaign,
  extra: Partial<React.ComponentProps<typeof CampaignBoard>> = {}
) => {
  useCampaignStore.setState({ campaigns: [c], loaded: true })
  // The store is read through a poller; no backend here, so keep it quiet.
  return render(
    <CampaignBoard
      campaignId={c.id}
      actions={actions}
      loadDiff={load}
      loadSummary={load}
      loadEvents={async () => []}
      loadActivity={async () => []}
      {...extra}
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
    // Raw counts are not on the surface: the cost is one plain figure.
    expect(screen.queryByTestId('campaign-budget')).toBeNull()
    expect(screen.getByTestId('campaign-cost')).toHaveTextContent('tokens')
    expect(screen.getByTestId('campaign-summary')).toBeInTheDocument()
    expect(screen.queryByText('Attempts')).toBeNull()
    expect(screen.queryByText('Tokens used')).toBeNull()
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

  it('tells what a task did in a sentence and how long it took', async () => {
    show(
      campaign([
        task('a', {
          status: 'merged',
          sessionId: 's-a',
          worktreePath: '/w/a',
          brief: 'Write the JSON storage layer',
        }),
      ], { status: 'done' }),
      {
        loadSummary: async () => ({
          files: [
            { path: 'a.ts', status: 'added', added: 100, removed: 0, binary: false, truncated: false },
            { path: 'b.ts', status: 'added', added: 76, removed: 0, binary: false, truncated: false },
          ],
          added: 176,
          removed: 0,
          truncated: false,
          uncommitted: false,
        }),
        loadEvents: async () => [
          { ts: '2026-01-01T10:00:00Z', kind: 'task-status', task: 'a', detail: 'Queued -> Running' },
          { ts: '2026-01-01T10:03:00Z', kind: 'task-status', task: 'a', detail: 'Running -> Merged' },
        ],
      }
    )
    expect(
      await screen.findByText(/Wrote 2 files, \+176 −0 lines/)
    ).toBeInTheDocument()
    expect(await screen.findByTestId('campaign-task-time-a')).toHaveTextContent(
      'Took 3 min'
    )
    expect(screen.getByTestId('campaign-wrapup')).toBeInTheDocument()
  })

  it('shows the real error and a recommended action for a stuck task, and sends the hint with Retry', async () => {
    show(
      campaign([
        task('a', {
          status: 'failed',
          sessionId: 's-a',
          detail: 'the shell failed 3 times',
        }),
      ]),
      {
        loadActivity: async () =>
          [
            {
              tool: 'bash',
              summary: 'npm test',
              phase: 'failed',
              exit_code: 1,
              output: 'ENOENT: no such file or directory, open data.json',
              requested_at_ms: 1,
            },
          ] as never,
      }
    )
    const err = await screen.findByTestId('campaign-error-a')
    expect(err).toHaveTextContent('ENOENT: no such file or directory')
    expect(screen.getByTestId('campaign-stuck-a')).toHaveTextContent(
      'Try again, and say what it should do differently.'
    )
    fireEvent.change(screen.getByTestId('campaign-hint-a'), {
      target: { value: 'use the sync fs api' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(actions.retryTask).toHaveBeenCalledWith('c1', 'a', 'use the sync fs api')
  })

  it('shows the step by step story when asked, and degrades without a record', async () => {
    show(
      campaign([
        task('a', { status: 'verified', sessionId: 's-a', brief: 'Do the thing' }),
      ]),
      {
        loadActivity: async () =>
          [
            { tool: 'read', summary: 'src/a.ts', phase: 'succeeded', requested_at_ms: 1 },
            { tool: 'write', summary: 'src/b.ts', phase: 'succeeded', requested_at_ms: 2 },
          ] as never,
      }
    )
    fireEvent.click(screen.getByTestId('campaign-story-toggle-a'))
    expect(await screen.findByText('Read src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('Wrote src/b.ts')).toBeInTheDocument()
    expect(screen.getByText('Do the thing')).toBeInTheDocument()
  })

  it('offers Check again and Accept anyway for a blocked check, and names what waits', async () => {
    show(
      campaign([
        task('a', {
          status: 'completed',
          verdict: 'BLOCKED',
          sessionId: 's-a',
          detail: 'verification blocked: the model could not be reached',
        }),
        task('b', { status: 'pending', dependsOn: ['a'] }),
      ])
    )
    const section = screen.getByTestId('campaign-section-needs-you')
    expect(section).toHaveTextContent('the model could not be reached')
    expect(screen.getByTestId('campaign-blocks-a')).toHaveTextContent('Task b')
    fireEvent.click(screen.getByTestId('campaign-verify-a'))
    expect(actions.verifyAgain).toHaveBeenCalledWith('c1', 'a')

    await waitFor(() =>
      expect(screen.getByTestId('campaign-accept-a')).not.toBeDisabled()
    )
    fireEvent.click(screen.getByTestId('campaign-accept-a'))
    fireEvent.change(screen.getByTestId('campaign-accept-reason-a'), {
      target: { value: 'tests pass locally' },
    })
    fireEvent.click(screen.getByTestId('campaign-accept-confirm-a'))
    expect(actions.acceptAnyway).toHaveBeenCalledWith(
      'c1',
      'a',
      'you',
      'tests pass locally'
    )
  })

  it('shows who accepted a task and why', () => {
    show(
      campaign([
        task('a', {
          status: 'verified',
          manualOverride: {
            by: 'you',
            reason: 'checked by hand',
            at: '2026-01-01T00:00:00Z',
            previousVerdict: 'BLOCKED',
          },
        }),
      ])
    )
    expect(screen.getByTestId('campaign-override-a')).toHaveTextContent(
      'Accepted by you: checked by hand'
    )
  })

  it('prefills the retry hint for a task that needs help', () => {
    show(
      campaign([
        task('a', {
          status: 'failed',
          attempt: 0,
          detail: 'needs help: the test runner cannot start in the sandbox',
        }),
      ])
    )
    expect(
      (screen.getByTestId('campaign-hint-a') as HTMLTextAreaElement).value
    ).toContain('--test-isolation=none')
  })
})
