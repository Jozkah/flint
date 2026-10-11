import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import { CampaignGroups } from '../CampaignGroups'
import type { CampaignGroup } from '@/lib/campaignView'

const group: CampaignGroup = {
  campaignId: 'c1',
  title: 'Ship it',
  status: 'running',
  done: 3,
  total: 5,
  finished: false,
  rows: [
    { sessionId: 'coord', role: 'coordinator' },
    { sessionId: 's1', role: 'task', taskId: 'a', dot: 'running' },
  ],
}

describe('CampaignGroups', () => {
  it('renders nothing without campaigns', () => {
    const { container } = render(
      <ul>
        <CampaignGroups groups={[]} renderRow={() => null} />
      </ul>
    )
    expect(container.querySelector('li')).toBeNull()
  })

  it('shows the header with progress and one row per session', () => {
    render(
      <ul>
        <CampaignGroups
          groups={[group]}
          renderRow={(r) => <li key={r.sessionId}>{`row ${r.sessionId}`}</li>}
        />
      </ul>
    )
    expect(screen.getByText('Ship it')).toBeInTheDocument()
    expect(screen.getByTestId('campaign-group-progress')).toBeInTheDocument()
    expect(screen.getByText('row coord')).toBeInTheDocument()
    expect(screen.getByText('row s1')).toBeInTheDocument()
  })

  it('opens the board from the header', () => {
    render(
      <ul>
        <CampaignGroups groups={[group]} renderRow={() => null} />
      </ul>
    )
    fireEvent.click(screen.getByTitle('settings:campaigns.board.openBoard'))
    expect(navigate).toHaveBeenCalledWith({
      to: '/campaign/$campaignId',
      params: { campaignId: 'c1' },
    })
  })

  it('folds a finished campaign to one line and unfolds on request', () => {
    const over: CampaignGroup = { ...group, status: 'done', finished: true }
    render(
      <ul>
        <CampaignGroups
          groups={[over]}
          renderRow={(r) => <li key={r.sessionId}>{`row ${r.sessionId}`}</li>}
        />
      </ul>
    )
    expect(screen.queryByText('row coord')).toBeNull()
    expect(screen.getByTestId('campaign-group-progress')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('row coord')).toBeInTheDocument()
    expect(screen.getByText('row s1')).toBeInTheDocument()
  })
})
