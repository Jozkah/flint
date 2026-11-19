import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { ReactNode } from 'react'

const listRenders = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => undefined,
}))
vi.mock('@/lib/groups/homeMirror', () => ({ startHomeProjectsMirror: () => () => {} }))
vi.mock('@/hooks/useMoveToGroup', () => ({ useMoveToGroup: () => vi.fn() }))
vi.mock('@/components/shell/nav/GroupFoldersDialog', () => ({ GroupFoldersDialog: () => null }))
vi.mock('@/components/shell/nav/GroupPrompts', () => ({ GroupPrompts: () => null }))
vi.mock('@/containers/dialogs/AddProjectDialog', () => ({ default: () => null }))
vi.mock('@/containers/dialogs/DeleteProjectDialog', () => ({ DeleteProjectDialog: () => null }))
vi.mock('@/containers/dialogs/DeleteAllThreadsDialog', () => ({ DeleteAllThreadsDialog: () => null }))
vi.mock('@/containers/dialogs/DeleteSelectedThreadsDialog', () => ({
  DeleteSelectedThreadsDialog: () => null,
}))
vi.mock('@/containers/ThreadList', async () => {
  const { memo } = await import('react')
  return {
    default: memo(function ThreadList({ threads }: { threads: { id: string; title?: string }[] }) {
      listRenders.count++
      return (
        <>
          {threads.map((th) => (
            <li key={th.id}>{th.title}</li>
          ))}
        </>
      )
    }),
  }
})
vi.mock('@/components/shell/nav-kit', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    NavCollapse: Pass,
    NavGroup: Pass,
    NavGroupAction: Pass,
    NavGroupLabel: Pass,
    NavList: Pass,
    useCloseDrawer: () => () => {},
    useShellNav: () => ({ isMobile: false }),
  }
})

import { ChatsNav } from '../ChatsNav'
import { useThreads } from '@/hooks/useThreads'
import { useThreadManagementStore } from '@/hooks/useThreadManagement'
import { useConversationGroups } from '@/lib/groups/store'
import { emptyGroupsState } from '@/lib/groups/domain'

const folders = [
  { id: 'f1', name: 'One', updated_at: 1 },
  { id: 'f2', name: 'Two', updated_at: 1 },
]

const coworkGroup = (linkedGroupId?: string) => ({
  id: 'c1',
  surface: 'cowork' as const,
  name: 'Ops',
  parentId: null,
  position: 0,
  collapsed: false,
  folderBindings: [],
  ...(linkedGroupId ? { linkedGroupId } : {}),
  createdAt: 1,
  updatedAt: 1,
})

function withCoworkGroup(linkedGroupId?: string) {
  const state = emptyGroupsState()
  state.surfaces.cowork.groups = [coworkGroup(linkedGroupId)]
  useConversationGroups.setState({ state })
}

beforeEach(() => {
  const threads: Record<string, Thread> = {}
  folders.forEach((project, i) => {
    threads[`t${i}`] = {
      id: `t${i}`,
      title: `Chat ${i}`,
      updated: 1000 + i,
      metadata: { project },
    } as unknown as Thread
  })
  useThreads.setState({ threads, isLoadingThreads: false })
  useThreadManagementStore.setState({ folders } as never)
})

describe('ChatsNav linked group', () => {
  it('shows the link icon only on the chat group a Cowork group links to', () => {
    withCoworkGroup('f1')
    render(<ChatsNav />)
    const icons = screen.getAllByTestId('chat-group-linked-icon')
    expect(icons).toHaveLength(1)
    expect(icons[0]).toHaveAttribute('aria-label', 'common:groups.chatLinkedToCowork')
  })

  it('shows no link icon when nothing is linked', () => {
    withCoworkGroup()
    render(<ChatsNav />)
    expect(screen.queryByTestId('chat-group-linked-icon')).toBeNull()
  })

  it('unlinks the Cowork group from the group menu', () => {
    withCoworkGroup('f1')
    const setLink = vi.fn().mockResolvedValue(true)
    useConversationGroups.setState({ setLink } as never)
    render(<ChatsNav />)
    const linkedHeader = screen
      .getAllByTestId('chat-group-header')
      .find((h) => h.querySelector('[data-testid="chat-group-linked-icon"]'))!
    fireEvent.contextMenu(linkedHeader, { clientX: 40, clientY: 50 })
    fireEvent.click(screen.getByTestId('chat-group-unlink-cowork'))
    expect(setLink).toHaveBeenCalledWith('cowork', 'c1', null)
  })
})
