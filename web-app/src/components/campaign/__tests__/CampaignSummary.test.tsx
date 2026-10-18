import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

import { CampaignSummary } from '../CampaignSummary'
import type { Campaign } from '@/lib/campaignModel'

const campaign = (over: Partial<Campaign>): Campaign =>
  ({
    schemaVersion: 1,
    id: 'c',
    title: 'T',
    baseBranch: 'main',
    integrationBranch: 'flint/c',
    limits: { maxParallel: 3, maxTasks: 12 },
    status: 'running',
    createdAt: '2026-01-01T10:00:00Z',
    updatedAt: '2026-01-01T11:00:00Z',
    tasks: [],
    ...over,
  }) as Campaign

describe('CampaignSummary branch', () => {
  it('names the integration branch', () => {
    render(<CampaignSummary campaign={campaign({})} totals={null} />)
    expect(screen.getByText(/flint\/c/)).toBeInTheDocument()
  })

  it('falls back to the base branch', () => {
    render(
      <CampaignSummary
        campaign={campaign({ integrationBranch: '' })}
        totals={null}
      />
    )
    expect(screen.getByText(/branch, main\./)).toBeInTheDocument()
  })

  it('hides the branch section when the record has no branch at all', () => {
    render(
      <CampaignSummary
        campaign={campaign({ integrationBranch: '', baseBranch: '' })}
        totals={null}
      />
    )
    expect(screen.queryByTestId('campaign-copy-branch')).toBeNull()
    expect(screen.queryByText(/branch, \./)).toBeNull()
  })
})
