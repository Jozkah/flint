/**
 * The approval card for a proposed memory.
 *
 * Two things are asserted that this programme has got wrong before: that the
 * card shows the backend's *reason* rather than a generic prompt, and that a
 * conflicted proposal offers no way to approve one side. The backend refuses
 * both cases too; these cover the visible half.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PendingProposal } from '@janhq/tauri-plugin-agent-tools-api'

const memoryProposalResolve = vi.fn()
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  memoryProposalResolve: (...a: unknown[]) => memoryProposalResolve(...a),
}))

import { MemoryProposalCard, MemoryProposalList } from '../MemoryProposalCard'

const location = { dataFolder: '/data' } as never

const proposal = (over: Partial<PendingProposal> = {}): PendingProposal =>
  ({
    id: 'mem-1',
    content: 'The user prefers tabs over spaces.',
    scope: 'user',
    reason: 'automatic-saving-disabled',
    explanation: 'Automatic saving is off, so this is waiting for you.',
    approvable: true,
    sourceSessionId: 'chat-a',
    sourceMessageId: 'msg-1',
    createdAt: 1_700_000_000,
    ...over,
  }) as PendingProposal

beforeEach(() => {
  memoryProposalResolve.mockReset().mockResolvedValue(null)
})

describe('the approval card', () => {
  it('shows what would be remembered and where it would apply', () => {
    render(
      <MemoryProposalCard
        proposal={proposal()}
        location={location}
        onResolved={vi.fn()}
      />
    )
    expect(screen.getByTestId('memory-proposal-content')).toHaveTextContent(
      'prefers tabs'
    )
    expect(screen.getByText(/apply to everywhere/i)).toBeInTheDocument()
  })

  /// The reason is the whole value of the card. Three different situations
  /// behind one prompt would push a user to answer them all the same way.
  it.each([
    [
      'automatic-saving-disabled',
      'Automatic saving is off, so this is waiting for you.',
    ],
    [
      'would-promote-project-fact-globally',
      'This was learned in a project and would apply everywhere.',
    ],
  ])('shows the backend reason for %s', (reason, explanation) => {
    render(
      <MemoryProposalCard
        proposal={proposal({ reason: reason as never, explanation })}
        location={location}
        onResolved={vi.fn()}
      />
    )
    const shown = screen.getByTestId('memory-proposal-explanation')
    expect(shown).toHaveTextContent(explanation)
    expect(shown).not.toHaveTextContent(/needs approval/i)
  })

  it('approves through the backend, not by itself', async () => {
    const onResolved = vi.fn()
    render(
      <MemoryProposalCard
        proposal={proposal()}
        location={location}
        onResolved={onResolved}
      />
    )
    await userEvent.click(screen.getByTestId('memory-proposal-approve'))
    expect(memoryProposalResolve).toHaveBeenCalledWith(
      location,
      'user',
      'mem-1',
      true
    )
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('mem-1', true))
  })

  it('discards through the backend', async () => {
    const onResolved = vi.fn()
    render(
      <MemoryProposalCard
        proposal={proposal()}
        location={location}
        onResolved={onResolved}
      />
    )
    await userEvent.click(screen.getByTestId('memory-proposal-reject'))
    expect(memoryProposalResolve).toHaveBeenCalledWith(
      location,
      'user',
      'mem-1',
      false
    )
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('mem-1', false))
  })

  /// Approving one side of a disagreement without seeing the other is not a
  /// decision anyone can make well.
  it('offers no way to approve a conflicted proposal', () => {
    render(
      <MemoryProposalCard
        proposal={proposal({
          approvable: false,
          reason: 'conflicts-with-existing',
          explanation:
            'This contradicts something already remembered. Both are being withheld until you say which is right.',
        })}
        location={location}
        onResolved={vi.fn()}
      />
    )
    expect(screen.queryByTestId('memory-proposal-approve')).toBeNull()
    expect(
      screen.getByTestId('memory-proposal-resolve-conflict')
    ).toBeInTheDocument()
    // Discarding is still allowed: refusing a proposal needs no adjudication.
    expect(screen.getByTestId('memory-proposal-reject')).toBeInTheDocument()
  })

  /// The backend re-runs the refusals at approval time. When it says no, the
  /// card says why rather than silently doing nothing.
  it('shows the reason when the backend refuses', async () => {
    memoryProposalResolve.mockRejectedValue({
      message: 'that looks like a credential, so it was discarded rather than saved',
    })
    const onResolved = vi.fn()
    render(
      <MemoryProposalCard
        proposal={proposal()}
        location={location}
        onResolved={onResolved}
      />
    )
    await userEvent.click(screen.getByTestId('memory-proposal-approve'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/credential/)
    // And the card stays, because nothing was resolved.
    expect(onResolved).not.toHaveBeenCalled()
    expect(screen.getByTestId('memory-proposal-card')).toBeInTheDocument()
  })

  it('sends one answer even if the button is clicked twice', async () => {
    let release: (v: unknown) => void = () => {}
    memoryProposalResolve.mockReturnValue(
      new Promise((r) => {
        release = r
      })
    )
    render(
      <MemoryProposalCard
        proposal={proposal()}
        location={location}
        onResolved={vi.fn()}
      />
    )
    const approve = screen.getByTestId('memory-proposal-approve')
    await userEvent.click(approve)
    await userEvent.click(approve)
    expect(memoryProposalResolve).toHaveBeenCalledTimes(1)
    await act(async () => release(null))
  })
})

describe('the list', () => {
  it('renders nothing at all when there is nothing to answer', () => {
    const { container } = render(
      <MemoryProposalList
        proposals={[]}
        location={location}
        onResolved={vi.fn()}
      />
    )
    // Not an empty heading: a standing reminder of an unused feature.
    expect(container).toBeEmptyDOMElement()
  })

  it('renders one card per proposal', () => {
    render(
      <MemoryProposalList
        proposals={[proposal(), proposal({ id: 'mem-2' })]}
        location={location}
        onResolved={vi.fn()}
      />
    )
    expect(screen.getAllByTestId('memory-proposal-card')).toHaveLength(2)
  })
})
