/**
 * A child's approval request is shown on its own and answered there. Before,
 * it was visible only when its call id happened to match a tool card in the
 * parent's transcript, and a child whose second call matched nothing waited
 * forever -- found by the AH-109 Windows scenario.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({}) }))

import { CoworkChildApprovals } from '../CoworkChildApprovals'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useToolApproval } from '@/hooks/useToolApproval'

describe('CoworkChildApprovals', () => {
  beforeEach(() => {
    useToolApprovalRequests.setState({ pending: {}, queued: {} })
    useToolApproval.setState({ allowAllMCPPermissions: false })
  })

  it('shows a child’s request with its diff, and the answer reaches the child', async () => {
    render(<CoworkChildApprovals sessionId="s1" />)
    let answer!: Promise<boolean>
    act(() => {
      answer = useToolApprovalRequests
        .getState()
        .requestApproval('call_1', 'write', 's1', undefined, '+beta line', 'worker (its own checkout)')
    })
    const card = await screen.findByTestId('child-approval')
    expect(card.getAttribute('data-origin')).toBe('worker (its own checkout)')
    expect(within(card).getByTestId('approval-preview').textContent).toContain('beta line')
    // The label is the translation key under the test i18n; either spelling.
    await userEvent.click(
      within(card).getByRole('button', { name: /allow ?once/i })
    )
    expect(await answer).toBe(true)
    expect(screen.queryByTestId('child-approval')).toBeNull()
  })

  it('leaves the conversation’s own requests to their tool cards, and other sessions’ alone', async () => {
    render(<CoworkChildApprovals sessionId="s1" />)
    act(() => {
      void useToolApprovalRequests.getState().requestApproval('own', 'write', 's1')
      void useToolApprovalRequests
        .getState()
        .requestApproval('other', 'write', 's2', undefined, undefined, 'worker')
    })
    expect(screen.queryByTestId('child-approval')).toBeNull()
  })
})
