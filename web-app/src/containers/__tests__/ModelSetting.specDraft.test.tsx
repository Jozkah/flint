import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const hoisted = vi.hoisted(() => ({
  getMtpInfo: vi.fn(),
  updateMtpSettings: vi.fn(),
}))

vi.mock('@/hooks/useServiceHub', () => {
  const hub = {
    models: () => ({
      getMtpInfo: hoisted.getMtpInfo,
      updateMtpSettings: hoisted.updateMtpSettings,
    }),
  }
  return { useServiceHub: () => hub, getServiceHub: () => hub }
})

import { SpecDraftPanel } from '../ModelSetting'

// llama.cpp is linked into the worker at a pinned version, so there is no
// backend build number left to gate MTP on.
describe('SpecDraftPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.updateMtpSettings.mockResolvedValue(undefined)
  })

  it('offers the toggle for a model with MTP heads', async () => {
    hoisted.getMtpInfo.mockResolvedValue({ mtp_layers: 2, mtp: false })
    render(<SpecDraftPanel modelId="glm" />)

    const toggle = await screen.findByRole('switch')
    expect(toggle).toBeEnabled()
  })

  it('reports a model whose MTP is already on as on', async () => {
    hoisted.getMtpInfo.mockResolvedValue({ mtp_layers: 2, mtp: true })
    render(<SpecDraftPanel modelId="glm" />)

    const [toggle] = await screen.findAllByRole('switch')
    expect(toggle).toBeChecked()
  })

  it('shows the draft sampling switch only while speculative decoding is on', async () => {
    hoisted.getMtpInfo.mockResolvedValue({ mtp_layers: 2, mtp: false })
    const off = render(<SpecDraftPanel modelId="glm" />)
    await screen.findByRole('switch')
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    off.unmount()

    hoisted.getMtpInfo.mockResolvedValue({
      mtp_layers: 2,
      mtp: true,
      spec_draft_sampling: 'probabilistic',
    })
    render(<SpecDraftPanel modelId="glm" />)
    const switches = await screen.findAllByRole('switch')
    expect(switches).toHaveLength(2)
    expect(switches[1]).toBeChecked()
  })

  it('renders nothing for a model with no MTP heads', async () => {
    hoisted.getMtpInfo.mockResolvedValue({ mtp_layers: 0, mtp: false })
    render(<SpecDraftPanel modelId="llama" />)

    await waitFor(() => expect(hoisted.getMtpInfo).toHaveBeenCalled())
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})
