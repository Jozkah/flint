import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o?.name ? `${k}#${o.name}` : o?.count !== undefined ? `${k}#${o.count}` : k,
  }),
}))
vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => true }))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    events: () => ({ listen: vi.fn(async () => () => {}) }),
  }),
}))

const { held, approveHeld, denyHeld } = vi.hoisted(() => ({
  held: vi.fn(),
  approveHeld: vi.fn(),
  denyHeld: vi.fn(),
}))
vi.mock('@/lib/sessionMailbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sessionMailbox')>()
  return {
    ...actual,
    sessionMailbox: { ...actual.sessionMailbox, held, approveHeld, denyHeld },
  }
})

import { HeldInboundStack } from '../HeldInboundStack'
import type { MailEnvelope } from '@/lib/sessionMailbox'

const envelope: MailEnvelope = {
  v: 1,
  id: 'm1',
  from: { sessionId: 'S1', displayName: 'Backend' },
  to: { sessionId: 'A' },
  project: 'p',
  text: 'rebase <img src=x onerror=alert(1)>',
  createdAt: Date.now(),
  depth: 0,
  origin: 'agent',
}

describe('HeldInboundStack', () => {
  beforeEach(() => {
    held.mockReset()
    approveHeld.mockReset().mockResolvedValue(true)
    denyHeld.mockReset().mockResolvedValue(true)
  })

  it('renders nothing when nothing is held', async () => {
    held.mockResolvedValue([])
    const { container } = render(<HeldInboundStack sessionId="A" />)
    await waitFor(() => expect(held).toHaveBeenCalledWith('A'))
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a held message as plain text and approves it once', async () => {
    held.mockResolvedValueOnce([envelope]).mockResolvedValue([])
    render(<HeldInboundStack sessionId="A" />)
    const card = await screen.findByTestId('held-inbound-m1')
    expect(card).toHaveTextContent('rebase <img src=x onerror=alert(1)>')
    expect(card.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByTestId('held-inbound-approve'))
    expect(approveHeld).toHaveBeenCalledWith('A', 'm1')
    expect(denyHeld).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('held-inbound-m1')).toBeNull())
  })

  it('denies a held message', async () => {
    held.mockResolvedValueOnce([envelope]).mockResolvedValue([])
    render(<HeldInboundStack sessionId="A" />)
    await screen.findByTestId('held-inbound-m1')
    fireEvent.click(screen.getByTestId('held-inbound-deny'))
    expect(denyHeld).toHaveBeenCalledWith('A', 'm1')
    expect(approveHeld).not.toHaveBeenCalled()
  })
})
