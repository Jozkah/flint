/**
 * useMemoryProposals must show the proposals of the thread in view, even when
 * a list requested for the previous thread answers last (#248).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const memoryProposalsList = vi.fn()
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  memoryProposalsList: (...a: unknown[]) => memoryProposalsList(...a),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    app: () => ({ getJanDataFolder: async () => '/data' }),
  }),
}))

import { useMemoryProposals } from '../useMemoryProposals'

const proposal = (id: string, session: string) =>
  ({ id, sourceSessionId: session }) as unknown as never

describe('useMemoryProposals', () => {
  beforeEach(() => {
    memoryProposalsList.mockReset()
  })

  it('ignores a list for the previous thread that answers after the current one', async () => {
    const pending: Array<(v: unknown) => void> = []
    memoryProposalsList.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve))
    )
    const { result, rerender } = renderHook(
      ({ sessionId }) => useMemoryProposals({ sessionId }),
      { initialProps: { sessionId: 'A' } }
    )
    await waitFor(() => expect(pending).toHaveLength(1))

    rerender({ sessionId: 'B' })
    await waitFor(() => expect(pending).toHaveLength(2))

    const all = [proposal('pa', 'A'), proposal('pb', 'B')]
    await act(async () => {
      pending[1](all)
    })
    expect(result.current.proposals.map((p) => p.id)).toEqual(['pb'])

    await act(async () => {
      pending[0](all)
    })
    expect(result.current.proposals.map((p) => p.id)).toEqual(['pb'])
  })
})
