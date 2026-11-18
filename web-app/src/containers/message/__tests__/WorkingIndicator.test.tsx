import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'

vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({}) }))

import { WorkingIndicator } from '../WorkingIndicator'
import { ConversationPaneContext } from '@/hooks/useConversationPane'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'

const renderIn = (threadId: string) =>
  render(
    <ConversationPaneContext.Provider value={{ threadId } as never}>
      <WorkingIndicator />
    </ConversationPaneContext.Provider>
  )

describe('WorkingIndicator', () => {
  beforeEach(() => useToolApprovalRequests.setState({ pending: {}, queued: {} }))

  it('says Working while nothing waits, and Waiting for your approval once a question for this thread does', () => {
    renderIn('s1')
    expect(screen.getByTestId('transcript-working').textContent).toMatch(/workingEllipsis/)
    act(() => {
      void useToolApprovalRequests
        .getState()
        .requestApproval('r:attach-folder', 'attach_folder', 's1', undefined, {
          input: {},
          origin: 'run',
          alwaysAsk: true,
        })
    })
    expect(screen.getByTestId('transcript-working').textContent).toMatch(
      /waitingApproval/
    )
  })

  it('ignores another thread’s question', () => {
    renderIn('s1')
    act(() => {
      void useToolApprovalRequests
        .getState()
        .requestApproval('x', 'write', 's2', undefined, { input: {}, origin: 'run' })
    })
    expect(screen.getByTestId('transcript-working').textContent).toMatch(/workingEllipsis/)
  })
})
