import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const navigate = vi.hoisted(() => vi.fn())
const route = vi.hoisted(() => ({ pathname: '/' }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useLocation: ({ select }: { select: (l: { pathname: string }) => string }) =>
    select(route),
}))
vi.mock('@/containers/rooms/roomsBindings', () => ({
  useRoomsState: () => ({ summaries: [{ id: 'room-1', title: 'Design room' }] }),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { HeaderLiveChips } from '../HeaderLiveChips'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'

const selectSession = vi.fn()

beforeEach(() => {
  route.pathname = '/'
  navigate.mockReset()
  selectSession.mockReset()
  useCoworkSessions.setState({
    sessions: [{ id: 'cw-1', title: 'Build the release' } as never],
    selectSession,
  })
  useCoworkRun.setState({ runs: {}, liveTurns: {} })
  useToolApprovalRequests.setState({ pending: {}, queued: {} })
})

describe('header live-work pills', () => {
  it('the approval pill opens the conversation that has waited longest', () => {
    const entry = (requestId: string, threadId: string, requestedAt: number) =>
      ({
        requestId,
        toolCallId: requestId,
        toolName: 'bash',
        threadId,
        requestedAt,
        resolve: () => {},
      }) as never
    useToolApprovalRequests.setState({
      pending: {
        a: entry('a', 'room-1', Date.now() - 1_000),
        b: entry('b', 'cw-1', Date.now() - 60_000),
      },
      queued: {},
    })
    render(<HeaderLiveChips />)
    const pill = screen.getByTestId('header-approvals-chip')
    expect(pill).not.toHaveAttribute('title')
    fireEvent.click(pill)
    expect(selectSession).toHaveBeenCalledWith('cw-1')
    expect(navigate).toHaveBeenCalledWith({ to: '/cowork' })
  })

  it('the runs pill opens the one running session', () => {
    useCoworkRun.setState({
      runs: { 'cw-1': { runId: 'r', startedAt: Date.now() - 5_000 } },
    })
    render(<HeaderLiveChips />)
    const pill = screen.getByTestId('header-runs-chip')
    expect(pill).not.toHaveAttribute('title')
    fireEvent.click(pill)
    expect(selectSession).toHaveBeenCalledWith('cw-1')
    expect(navigate).toHaveBeenCalledWith({ to: '/cowork' })
  })

  it('is not repeated on the Cowork page when the only run is the session in view', () => {
    useCoworkRun.setState({
      runs: { 'cw-1': { runId: 'r', startedAt: Date.now() - 5_000 } },
    })
    route.pathname = '/cowork'
    useCoworkSessions.setState({ currentId: 'cw-1' } as never)
    const { unmount } = render(<HeaderLiveChips />)
    expect(screen.queryByTestId('header-runs-chip')).toBeNull()
    unmount()

    // Another session's run is not on screen: the pill stays.
    useCoworkSessions.setState({ currentId: 'cw-2' } as never)
    render(<HeaderLiveChips />)
    expect(screen.getByTestId('header-runs-chip')).toBeInTheDocument()
  })

  it('with several runs the pill lists them, and a row opens its session', () => {
    useCoworkRun.setState({
      runs: {
        'cw-1': { runId: 'r1', startedAt: Date.now() - 50_000 },
        'cw-2': { runId: 'r2', startedAt: Date.now() - 5_000 },
      },
    })
    render(<HeaderLiveChips />)
    fireEvent.click(screen.getByTestId('header-runs-chip'))
    expect(navigate).not.toHaveBeenCalled()
    const rows = screen.getAllByTestId('header-run-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Build the release')
    fireEvent.click(rows[1])
    expect(selectSession).toHaveBeenCalledWith('cw-2')
    expect(navigate).toHaveBeenCalledWith({ to: '/cowork' })
  })
})
