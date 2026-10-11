import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { Shell } from '../shell/Shell'
import { RemoteCallError } from '../api/client'
import { hashToRoute, routeToHash } from '../state/router'
import { resetApp, useFixtures } from './helpers'

const T = { timeout: 3000 }

const task = (over: Record<string, unknown>) => ({
  id: 't',
  title: 'Task',
  status: 'queued',
  dependsOn: [],
  attempt: 0,
  sessionId: null,
  detail: '',
  verdict: null,
  files: null,
  ...over,
})

const campaign = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  title: 'Rework the settings page',
  status: 'running',
  coordinatorSession: 'coord',
  updatedAt: new Date().toISOString(),
  tasks: [
    task({ id: 'a', title: 'Write the form', status: 'running', sessionId: 'sa', files: { count: 2, added: 40, removed: 3, uncommitted: false } }),
    task({ id: 'b', title: 'Fix the tests', status: 'failed', sessionId: 'sb', attempt: 1, detail: 'npm test exited 1' }),
    task({ id: 'c', title: 'Wire the route', status: 'pending', dependsOn: ['a'] }),
    task({ id: 'd', title: 'Rename keys', status: 'merged', sessionId: 'sd' }),
  ],
  maxParallel: 4,
  tokenBudget: null,
  tokensUsed: 1200,
  proposalId: null,
  gate: null,
  ...over,
})

const detail = (c = campaign(), extra: Record<string, unknown> = {}) => ({
  campaign: c,
  proposal: null,
  gateCommand: null,
  ...extra,
})

describe('phone Campaigns', () => {
  beforeEach(() => {
    resetApp({ name: 'campaigns' })
  })

  it('routes through the URL hash', () => {
    expect(routeToHash({ name: 'campaigns' })).toBe('#/campaigns')
    expect(hashToRoute('#/campaigns')).toEqual({ name: 'campaigns' })
    expect(routeToHash({ name: 'campaign', id: 'c 1' })).toBe('#/campaign/c%201')
    expect(hashToRoute('#/campaign/c%201')).toEqual({ name: 'campaign', id: 'c 1' })
  })

  it('lists campaigns with a plain headline and opens one', async () => {
    useFixtures({
      'campaigns.list': { campaigns: [campaign()] },
      'campaigns.get': detail(),
    })
    render(<Shell />)
    const row = await screen.findByTestId('campaign-row', {}, T)
    expect(row).toHaveTextContent('Rework the settings page')
    expect(row).toHaveTextContent('Needs your attention: 1 task is waiting for you')
    expect(row).toHaveTextContent('1 of 4 done')
    fireEvent.click(row)
    expect(await screen.findByTestId('campaign-detail', {}, T)).toBeInTheDocument()
  })

  it('says so when the computer is too old for campaigns', async () => {
    useFixtures({})
    render(<Shell />)
    expect(await screen.findByText(/too old to show campaigns/, {}, T)).toBeInTheDocument()
  })

  it('shows an empty state', async () => {
    useFixtures({ 'campaigns.list': { campaigns: [] } })
    render(<Shell />)
    expect(await screen.findByText('No campaigns yet', {}, T)).toBeInTheDocument()
  })

  it('groups tasks, shows files and offers retry, skip and pause', async () => {
    const client = useFixtures({
      'campaigns.get': detail(),
      'approvals.campaign.act': { ok: true },
    })
    resetApp({ name: 'campaign', id: 'c1' })
    render(<Shell />)
    expect(await screen.findByTestId('campaign-headline', {}, T)).toHaveTextContent('Needs your attention')
    const needs = screen.getByTestId('campaign-group-needs-you')
    expect(within(needs).getByText('Fix the tests')).toBeInTheDocument()
    expect(within(needs).getByText('npm test exited 1')).toBeInTheDocument()
    const working = screen.getByTestId('campaign-group-working')
    expect(within(working).getByText(/2 files, \+40 -3/)).toBeInTheDocument()
    expect(within(screen.getByTestId('campaign-group-up-next')).getByText(/Waiting for Write the form/)).toBeInTheDocument()
    expect(within(screen.getByTestId('campaign-group-done')).getByText('Rename keys')).toBeInTheDocument()

    fireEvent.click(within(needs).getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(client.rpc).toHaveBeenCalledWith('approvals.campaign.act', { id: 'c1', action: 'retry', taskId: 'b' })
    )
  })

  it('cancel asks first; Pause is the lead button while nothing needs the person', async () => {
    const client = useFixtures({
      'campaigns.get': detail(
        campaign({ tasks: [task({ id: 'a', title: 'Write', status: 'running', sessionId: 'sa' })] })
      ),
      'approvals.campaign.act': { ok: true },
    })
    resetApp({ name: 'campaign', id: 'c1' })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<Shell />)
    fireEvent.click(await screen.findByRole('button', { name: /^Cancel campaign$/ }, T))
    expect(confirm).toHaveBeenCalled()
    expect(client.rpc).not.toHaveBeenCalledWith('approvals.campaign.act', expect.anything())
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: /^Pause$/ }))
    await waitFor(() =>
      expect(client.rpc).toHaveBeenCalledWith('approvals.campaign.act', { id: 'c1', action: 'pause' })
    )
    confirm.mockRestore()
  })

  it('prepares the changes with the gate command shown, then applies once flagged files are ticked', async () => {
    const reviewing = campaign({ status: 'reviewing', tasks: [task({ id: 'a', title: 'Done', status: 'merged' })] })
    const client = useFixtures({
      'campaigns.get': detail(reviewing, { gateCommand: 'yarn test' }),
      'approvals.campaign.act': { ok: true },
    })
    resetApp({ name: 'campaign', id: 'c1' })
    render(<Shell />)
    expect(await screen.findByText(/Flint runs: yarn test/, {}, T)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check and prepare changes' }))
    await waitFor(() =>
      expect(client.rpc).toHaveBeenCalledWith('approvals.campaign.act', { id: 'c1', action: 'finalize' })
    )
  })

  it('applies the proposal only once flagged files are ticked, and never sends sensitive ones as chosen', async () => {
    const reviewing = campaign({ status: 'reviewing', tasks: [task({ id: 'a', title: 'Done', status: 'merged' })] })
    const proposed = detail(campaign({ status: 'merging', proposalId: 'p1', tasks: reviewing.tasks }), {
      proposal: {
        id: 'p1',
        state: 'pending',
        files: [
          { path: 'src/a.ts', change: 'modified', additions: 3, deletions: 1, binary: false, sensitive: false, flags: [] },
          { path: 'package.json', change: 'modified', additions: 1, deletions: 0, binary: false, sensitive: false, flags: ['Dependency change'] },
          { path: '.env', change: 'added', additions: 1, deletions: 0, binary: false, sensitive: true, flags: [] },
        ],
      },
    })
    const second = useFixtures({ 'campaigns.get': proposed, 'approvals.campaign.act': { ok: true } })
    resetApp({ name: 'campaign', id: 'c1' })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Shell />)
    const apply = await screen.findByRole('button', { name: 'Apply to the project' }, T)
    expect(screen.getByText(/Not applied: sensitive file/)).toBeInTheDocument()
    expect(apply).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/I looked at this file/))
    expect(apply).toBeEnabled()
    fireEvent.click(apply)
    await waitFor(() =>
      expect(second.rpc).toHaveBeenCalledWith('approvals.campaign.act', {
        id: 'c1',
        action: 'apply',
        acknowledged: ['package.json'],
      })
    )
    expect(confirm).toHaveBeenCalledWith('Apply 2 files to the project folder on your computer?')
    confirm.mockRestore()
  })

  it('shows the approvals of the coordinator and task sessions inside the campaign', async () => {
    useFixtures({
      'campaigns.get': detail(),
      status: { approvalsWaiting: 1, questionsWaiting: 0, promptsWaiting: 0, runs: [], modelsLoaded: 0 },
      'approvals.list': {
        approvals: [
          { requestId: 'r1', threadId: 'coord', toolName: 'campaign_plan', title: 'Start a campaign of 4 tasks', consequences: [], kind: 'cowork', createdAt: 1 },
          { requestId: 'r2', threadId: 'other', toolName: 'bash', title: 'Unrelated', consequences: [], kind: 'cowork', createdAt: 1 },
        ],
      },
    })
    resetApp({ name: 'campaign', id: 'c1' })
    render(<Shell />)
    const box = await screen.findByTestId('campaign-approvals', {}, T)
    expect(within(box).getByText('Start a campaign of 4 tasks')).toBeInTheDocument()
    expect(screen.queryByText('Unrelated')).not.toBeInTheDocument()
  })

  it('a desktop that refuses a call shows its reason, not a crash', async () => {
    const client = useFixtures({ 'campaigns.get': detail() })
    client.rpc.mockImplementation(async (m: string) => {
      if (m === 'campaigns.get') return detail()
      throw new RemoteCallError('refused', 'the campaign is paused, not reviewing')
    })
    resetApp({ name: 'campaign', id: 'c1' })
    render(<Shell />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }, T))
    expect(await screen.findByText('the campaign is paused, not reviewing', {}, T)).toBeInTheDocument()
  })
})
