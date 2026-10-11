import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import { StartCampaignDialog } from '../StartCampaignDialog'
import { useCampaignSettings } from '@/hooks/useCampaignSettings'
import type { StartDeps } from '@/lib/campaignStart'

const fakeDeps = (): StartDeps => ({
  createSession: vi.fn(() => 's1'),
  setFolder: vi.fn(),
  setTitle: vi.fn(),
  resolveModel: vi.fn(() => ({ provider: 'p', id: 'm' })),
  setModel: vi.fn(),
  launch: vi.fn(),
  select: vi.fn(),
  remove: vi.fn(),
})

describe('StartCampaignDialog', () => {
  it('asks for the goal and shows the parallel limit from the setting', () => {
    useCampaignSettings.setState({ maxParallel: 3 })
    render(
      <StartCampaignDialog
        open
        onOpenChange={() => {}}
        folder="/repo"
        deps={fakeDeps()}
      />
    )
    expect(
      screen.getByText('Describe the big task. Flint will plan how to split it.')
    ).toBeInTheDocument()
    expect(screen.getByTestId('campaign-start-hint')).toHaveTextContent(
      'Up to 3 threads'
    )
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
  })

  it('starts a coordinator session on the folder and opens Cowork', () => {
    const deps = fakeDeps()
    const close = vi.fn()
    render(
      <StartCampaignDialog open onOpenChange={close} folder="/repo" deps={deps} />
    )
    fireEvent.change(screen.getByTestId('campaign-goal'), {
      target: { value: 'add dark mode' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(deps.setFolder).toHaveBeenCalledWith('s1', '/repo')
    expect(vi.mocked(deps.launch).mock.calls[0][1]).toContain('campaign_plan')
    expect(deps.select).toHaveBeenCalledWith('s1')
    expect(close).toHaveBeenCalledWith(false)
    expect(navigate).toHaveBeenCalledWith({ to: '/cowork' })
  })

  it('shows an inline error and creates nothing when no model is usable', () => {
    const deps = { ...fakeDeps(), resolveModel: vi.fn(() => null) }
    const close = vi.fn()
    render(
      <StartCampaignDialog open onOpenChange={close} folder="/repo" deps={deps} />
    )
    fireEvent.change(screen.getByTestId('campaign-goal'), {
      target: { value: 'add dark mode' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(screen.getByTestId('campaign-start-error')).toBeInTheDocument()
    expect(deps.createSession).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })
})
