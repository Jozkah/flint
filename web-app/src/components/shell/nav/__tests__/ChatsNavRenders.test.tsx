import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import type { ReactNode } from 'react'

// Counts how often each group's row list renders.
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
import { useChatSessions } from '@/stores/chat-session-store'

const folders = [
  { id: 'f1', name: 'One', updated_at: 1 },
  { id: 'f2', name: 'Two', updated_at: 1 },
]

beforeEach(() => {
  listRenders.count = 0
  const threads: Record<string, Thread> = {}
  for (let i = 0; i < 300; i++) {
    const project = i % 3 === 2 ? undefined : folders[i % 3]
    threads[`t${i}`] = {
      id: `t${i}`,
      title: `Chat ${i}`,
      updated: 1000 + i,
      metadata: project ? { project } : {},
    } as unknown as Thread
  }
  useThreads.setState({ threads, isLoadingThreads: false })
  useThreadManagementStore.setState({ folders } as never)
})

describe('ChatsNav re-renders', () => {
  it('a title change re-renders only the group holding that chat', () => {
    render(<ChatsNav />)
    const initial = listRenders.count
    expect(initial).toBe(3)
    act(() => {
      useThreads.setState((s) => ({
        threads: { ...s.threads, t0: { ...s.threads.t0, title: 'Renamed' } },
      }))
    })
    expect(listRenders.count - initial).toBe(1)
  })

  it('session updates that do not start or stop a run render nothing', () => {
    render(<ChatsNav />)
    const initial = listRenders.count
    act(() => {
      useChatSessions.setState((s) => ({ sessions: { ...s.sessions } }))
    })
    expect(listRenders.count).toBe(initial)
  })
})
