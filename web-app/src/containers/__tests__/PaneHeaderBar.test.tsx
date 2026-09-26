import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, renderHook, screen, act } from '@testing-library/react'
import '@testing-library/jest-dom'

const stores = vi.hoisted(() => ({
  threads: {} as Record<string, { title?: string }>,
  sessions: [] as { id: string; title?: string }[],
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: (sel: (s: unknown) => unknown) =>
    sel({ threads: stores.threads }),
}))
vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: (sel: (s: unknown) => unknown) =>
    sel({ sessions: stores.sessions }),
}))
vi.mock('@/lib/rooms/store', () => ({
  useRoomsStore: (sel: (s: unknown) => unknown) => sel({ summaries: [] }),
}))

import { PaneHeaderBar } from '@/containers/PaneHeaderBar'
import { useSplitViewOpen } from '@/hooks/useSplitPaneTitle'
import {
  PRIMARY_PANE,
  useSplitConversation,
} from '@/hooks/useSplitConversation'

describe('PaneHeaderBar', () => {
  it('shows the title once, fading at the right edge, with the actions in the row', () => {
    render(
      <PaneHeaderBar
        paneId="p2"
        isActive
        title="can you check if these 2 issues are related"
        controls={<button>close pane</button>}
      >
        <button>Review changes</button>
      </PaneHeaderBar>
    )
    const header = screen.getByTestId('conversation-pane-header-p2')
    expect(
      screen.getAllByText('can you check if these 2 issues are related')
    ).toHaveLength(1)
    expect(screen.getByTestId('conversation-pane-title-p2')).toHaveClass(
      'text-fade'
    )
    expect(header).toContainElement(screen.getByText('Review changes'))
    expect(header).toContainElement(screen.getByText('close pane'))
    expect(header).toHaveAttribute('data-active', 'true')
  })

  it('marks an inactive pane', () => {
    render(
      <PaneHeaderBar paneId="p3" isActive={false} title="x" controls={null} />
    )
    expect(screen.getByTestId('conversation-pane-header-p3')).toHaveAttribute(
      'data-active',
      'false'
    )
  })
})

describe('the breadcrumb in split view', () => {
  beforeEach(() => {
    stores.sessions = [
      { id: 's1', title: 'Main session' },
      { id: 's2', title: 'Side session' },
    ]
    useSplitConversation.setState({
      panes: [
        { id: 'p2', kind: 'cowork', refId: 's2' },
        { id: 'p3', kind: 'chat' },
      ],
      sizes: [1 / 3, 1 / 3, 1 / 3],
      activePane: PRIMARY_PANE,
      maxPanes: 4,
    })
  })

  it('reports the split as open, whichever pane is active', () => {
    const { result } = renderHook(() => useSplitViewOpen())
    expect(result.current).toBe(true)
    act(() => useSplitConversation.getState().setActivePane('p2'))
    expect(result.current).toBe(true)
  })

  it('reports the split as closed once every side pane closes', () => {
    const { result } = renderHook(() => useSplitViewOpen())
    act(() => useSplitConversation.getState().closeAll())
    expect(result.current).toBe(false)
  })
})
