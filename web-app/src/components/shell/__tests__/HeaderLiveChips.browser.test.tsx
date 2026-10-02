import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: ({ select }: { select: (l: { pathname: string }) => string }) =>
    select({ pathname: '/' }),
}))
vi.mock('@/containers/rooms/roomsBindings', () => ({
  useRoomsState: () => ({ summaries: [] }),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { HeaderLiveChips } from '../HeaderLiveChips'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'

const entry = (toolCallId: string, toolName: string, resolve: (ok: boolean) => void) =>
  ({
    requestId: `req-${toolCallId}`,
    toolCallId,
    toolName,
    threadId: 'cw-1',
    requestedAt: Date.now() - 2_000,
    resolve,
  }) as never

async function openCard() {
  fireEvent.pointerEnter(screen.getByTestId('header-approvals-chip'))
  return screen.findAllByTestId('header-approval-row', {}, { timeout: 3000 })
}

beforeEach(() => {
  useCoworkSessions.setState({ sessions: [{ id: 'cw-1', title: 'Shopping' } as never] })
  useCoworkRun.setState({ runs: {}, liveTurns: {} })
  useToolApprovalRequests.setState({ pending: {}, queued: {}, refusals: {} })
})

describe('the approvals chip card and browser actions', () => {
  it('offers Allow and Deny on a browser approval, and Allow answers the request', async () => {
    const resolve = vi.fn()
    useToolApprovalRequests.setState({
      pending: { 'call-1': entry('call-1', 'browser_click', resolve) },
      queued: {},
    })
    render(<HeaderLiveChips />)
    await openCard()
    expect(screen.getByTestId('header-approval-actions')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('header-approval-allow'))
    // The request resolved as approved and left the store.
    expect(resolve).toHaveBeenCalledWith(true)
    expect(useToolApprovalRequests.getState().pending['call-1']).toBeUndefined()
  })

  it('Deny answers it as a refusal', async () => {
    const resolve = vi.fn()
    useToolApprovalRequests.setState({
      pending: { 'call-2': entry('call-2', 'browser_type', resolve) },
      queued: {},
    })
    render(<HeaderLiveChips />)
    await openCard()
    fireEvent.click(screen.getByTestId('header-approval-deny'))
    expect(resolve).toHaveBeenCalledWith(false)
    expect(useToolApprovalRequests.getState().pending['call-2']).toBeUndefined()
  })

  it('other tools keep the plain row (their prompts have detail the card does not show)', async () => {
    useToolApprovalRequests.setState({
      pending: { 'call-3': entry('call-3', 'bash', vi.fn()) },
      queued: {},
    })
    render(<HeaderLiveChips />)
    await openCard()
    expect(screen.queryByTestId('header-approval-actions')).toBeNull()
  })
})
