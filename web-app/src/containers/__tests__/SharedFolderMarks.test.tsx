import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o?.count !== undefined ? `${k}#${o.count}` : k,
  }),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ opener: () => ({ openUrl: vi.fn() }) }),
}))

import { ThreadStatusMark } from '../ThreadStatusMark'
import { PreviewCard } from '@/components/shell/nav/PreviewCard'
import {
  SHARED_WARNED_KEY,
  SharedFolderIsolationHint,
} from '../SharedFolderIsolationHint'

describe('sidebar mark', () => {
  it('shows the shared-folder mark in the status slot while nothing else marks the row', () => {
    render(<ThreadStatusMark status="none" shared={2} />)
    const mark = screen.getByTestId('thread-shared-mark')
    expect(mark).toHaveAttribute('data-status', 'shared')
    expect(mark).toHaveAttribute('title', 'common:sharedFolder.sidebarMark#2')
    // The same 14px slot the status dot and the fork mark use.
    expect(mark).toHaveClass('size-3.5')
  })

  it('yields to a real status, and names the fork when it is one', () => {
    const { rerender } = render(<ThreadStatusMark status="active" shared={1} />)
    expect(screen.queryByTestId('thread-shared-mark')).toBeNull()
    rerender(<ThreadStatusMark status="none" shared={1} fork />)
    expect(screen.getByTestId('thread-shared-mark').getAttribute('title')).toContain('chat:fork.chat')
    expect(screen.queryByTestId('thread-fork-mark')).toBeNull()
  })

  it('draws nothing extra for a session alone in its folder', () => {
    render(<ThreadStatusMark status="none" shared={0} />)
    expect(screen.queryByTestId('thread-shared-mark')).toBeNull()
  })
})

describe('hover card', () => {
  it('says the session shares a folder', () => {
    render(<PreviewCard title="Fix auth" meta={{ updated: Date.now(), sharedWith: 3 }} />)
    expect(screen.getByTestId('row-preview-shared')).toHaveTextContent(
      'common:sharedFolder.sidebarMark#3'
    )
  })

  it('says nothing without one', () => {
    render(<PreviewCard title="Fix auth" meta={{ updated: Date.now() }} />)
    expect(screen.queryByTestId('row-preview-shared')).toBeNull()
  })
})

describe('isolation hint', () => {
  it('explains the worktree and offers the shared folder', () => {
    const onUseShared = vi.fn()
    render(
      <SharedFolderIsolationHint reason="secondSession" choseShared={false} onUseShared={onUseShared} />
    )
    expect(screen.getByTestId('shared-folder-isolation')).toHaveTextContent(
      'common:sharedFolder.isolationHint'
    )
    fireEvent.click(screen.getByTestId('shared-folder-use-shared'))
    expect(onUseShared).toHaveBeenCalledOnce()
  })

  it('shows nothing when the default did not isolate the session', () => {
    const { container } = render(
      <SharedFolderIsolationHint reason={null} choseShared={false} onUseShared={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('warns about the git state guard once after the shared folder is chosen', () => {
    localStorage.removeItem(SHARED_WARNED_KEY)
    const { rerender, container } = render(
      <SharedFolderIsolationHint reason="fork" choseShared={false} onUseShared={() => {}} />
    )
    fireEvent.click(screen.getByTestId('shared-folder-use-shared'))
    rerender(<SharedFolderIsolationHint reason={null} choseShared onUseShared={() => {}} />)
    expect(screen.getByTestId('shared-folder-warning')).toHaveTextContent(
      'common:sharedFolder.sharedWarning'
    )
    fireEvent.click(screen.getByTestId('shared-folder-warning-dismiss'))
    expect(container).toBeEmptyDOMElement()

    // Not again, for this session or the next.
    rerender(<SharedFolderIsolationHint reason={null} choseShared onUseShared={() => {}} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<SharedFolderIsolationHint reason="fork" choseShared={false} onUseShared={() => {}} />)
    fireEvent.click(screen.getByTestId('shared-folder-use-shared'))
    expect(screen.queryByTestId('shared-folder-warning')).toBeNull()
  })
})
