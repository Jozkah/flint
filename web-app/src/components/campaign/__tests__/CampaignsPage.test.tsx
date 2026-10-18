import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/containers/HeaderPage', () => ({ default: () => null }))
vi.mock('@/lib/coworkParallel', () => ({ isGitRepo: vi.fn(async () => true) }))

import { CampaignsPage } from '../CampaignsPage'
import { useCampaignStore } from '@/hooks/useCampaigns'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { resetRepoCache } from '@/hooks/useCampaignFolder'
import type { Campaign } from '@/lib/campaignModel'

const campaign = (id: string, over: Partial<Campaign> = {}): Campaign =>
  ({
    schemaVersion: 1,
    id,
    title: `Campaign ${id}`,
    coordinatorSession: 'coord',
    sourceRoot: '/repo',
    baseBranch: 'main',
    baseSha: 'a',
    integrationBranch: 'flint/c',
    integrationWorktree: '/w',
    modeCeiling: 'auto',
    model: '',
    limits: { maxParallel: 3, maxTasks: 12 },
    status: 'running',
    processEpoch: 'e',
    createdAt: '2026-01-01T10:00:00Z',
    updatedAt: '2026-01-01T11:00:00Z',
    tasks: [
      { id: 'a', title: 'A', brief: '', acceptance: [], paths: [], dependsOn: [], status: 'merged', attempt: 0, tokensUsed: 0, detail: '' },
      { id: 'b', title: 'B', brief: '', acceptance: [], paths: [], dependsOn: [], status: 'running', attempt: 0, tokensUsed: 0, detail: '' },
    ],
    ...over,
  }) as Campaign

describe('CampaignsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRepoCache()
    useCoworkSessions.setState({ sessions: [], currentId: null } as never)
    vi.spyOn(useCampaignStore.getState(), 'refresh').mockResolvedValue()
  })

  it('explains what a campaign is when there are none, with a start button', () => {
    useCampaignStore.setState({ campaigns: [], loaded: true })
    render(<CampaignsPage />)
    expect(screen.getByText('No campaigns yet')).toBeInTheDocument()
    expect(screen.getAllByTestId('campaigns-start').length).toBeGreaterThan(0)
  })

  it('shows the real reason under the load error', () => {
    useCampaignStore.setState({
      campaigns: [],
      loaded: true,
      error: 'agent_campaign_list not allowed. Plugin not found',
    })
    render(<CampaignsPage />)
    expect(screen.getByTestId('campaigns-error-reason')).toHaveTextContent(
      'agent_campaign_list not allowed. Plugin not found'
    )
  })

  it('says campaigns need the desktop app instead of a load error', () => {
    useCampaignStore.setState({
      campaigns: [],
      loaded: true,
      error: null,
      unavailable: 'desktop',
    })
    render(<CampaignsPage />)
    expect(screen.getByText('Campaigns need the desktop app')).toBeInTheDocument()
    expect(screen.queryByTestId('campaigns-error')).toBeNull()
    expect(screen.getAllByTestId('campaigns-start')[0]).toBeDisabled()
  })

  it('tells a person to restart when the app is older than the page', () => {
    useCampaignStore.setState({
      campaigns: [],
      loaded: true,
      unavailable: null,
      error: 'Command agent_campaign_list not found',
      staleApp: true,
    })
    render(<CampaignsPage />)
    expect(screen.getByTestId('campaigns-stale-app')).toHaveTextContent(/restart/i)
  })

  it('still lists campaigns and names the records that were skipped', () => {
    useCampaignStore.setState({
      campaigns: [campaign('c1')],
      loaded: true,
      error: null,
      skipped: [{ id: 'c-bad', reason: 'the record of campaign c-bad is unreadable' }],
    })
    render(<CampaignsPage />)
    expect(screen.getByTestId('campaigns-row-c1')).toBeInTheDocument()
    expect(screen.getByTestId('campaigns-skipped')).toHaveTextContent('c-bad')
  })

  it('lists campaigns with plain status and progress, and opens the board', () => {
    useCampaignStore.setState({ campaigns: [campaign('c1')], loaded: true })
    render(<CampaignsPage />)
    const row = screen.getByTestId('campaigns-row-c1')
    expect(row).toHaveTextContent('Campaign c1')
    expect(row).toHaveTextContent('1 of 2 done')
    expect(row).toHaveTextContent('Working')
    fireEvent.click(row)
    expect(navigate).toHaveBeenCalledWith({
      to: '/campaign/$campaignId',
      params: { campaignId: 'c1' },
    })
  })

  it('opens the start dialog from the primary button', () => {
    useCampaignStore.setState({ campaigns: [campaign('c1')], loaded: true })
    render(<CampaignsPage />)
    fireEvent.click(screen.getByTestId('campaigns-start'))
    expect(screen.getByTestId('campaign-goal')).toBeInTheDocument()
  })

  it('keeps the list and shows a banner when a refresh fails', () => {
    useCampaignStore.setState({
      campaigns: [campaign('one')],
      loaded: true,
      error: 'the campaigns folder could not be read: denied',
    })
    render(<CampaignsPage />)
    expect(screen.getByTestId('campaigns-list')).toBeInTheDocument()
    expect(screen.getByTestId('campaigns-refresh-error')).toHaveTextContent(
      'the campaigns folder could not be read: denied'
    )
    expect(screen.queryByTestId('campaigns-error')).toBeNull()
  })

  it('shows no banner when the refresh worked', () => {
    useCampaignStore.setState({
      campaigns: [campaign('one')],
      loaded: true,
      error: null,
    })
    render(<CampaignsPage />)
    expect(screen.queryByTestId('campaigns-refresh-error')).toBeNull()
  })
})
