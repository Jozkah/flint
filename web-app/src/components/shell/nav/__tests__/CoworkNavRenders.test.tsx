import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { ReactNode } from 'react'

// Counts renders of the session list and of each row.
const counts = vi.hoisted(() => ({ tree: 0, rows: {} as Record<string, number> }))
const spies = vi.hoisted(() => ({
  buildBundle: vi.fn((input: unknown) => ({ bundle: input })),
  exportBundle: vi.fn(async () => ({ ok: true, redactions: 0 })),
  exportHandoff: vi.fn(async () => ({ ok: true, redactions: 0 })),
  docFromCowork: vi.fn(() => ({ title: 'doc' })),
  nest: [] as unknown[],
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const navigate = vi.hoisted(() => () => {})
const closeDrawer = vi.hoisted(() => () => {})
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: '/cowork' }),
}))
vi.mock('@/components/shell/nav-kit', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    NavItem: Pass,
    NavAction: Pass,
    NavButton: ({
      children,
      onClick,
      isActive: _isActive,
      ...rest
    }: {
      children?: ReactNode
      onClick?: () => void
      isActive?: boolean
    }) => (
      <button onClick={onClick} {...rest}>
        {children}
      </button>
    ),
    useCloseDrawer: () => closeDrawer,
    useShellNav: () => ({ isMobile: false }),
  }
})
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: Pass,
    DropdownMenuItem: ({
      children,
      onSelect,
      ...rest
    }: {
      children?: ReactNode
      onSelect?: () => void
    }) => (
      <button onClick={() => onSelect?.()} {...rest}>
        {children}
      </button>
    ),
  }
})
vi.mock('@/components/shell/nav/RowPreview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../RowPreview')>()
  return {
    ...actual,
    RowPreview: ({ children, title }: { children?: ReactNode; title: string }) => {
      counts.rows[title] = (counts.rows[title] ?? 0) + 1
      return <>{children}</>
    },
  }
})
vi.mock('@/components/shell/nav/GroupedTree', () => ({
  GroupedTree: ({
    ids,
    renderItem,
    nest,
  }: {
    ids: string[]
    renderItem: (id: string) => ReactNode
    nest: unknown
  }) => {
    counts.tree++
    spies.nest.push(nest)
    return <>{ids.map((id) => renderItem(id))}</>
  },
  MoveToGroupSub: () => null,
}))
vi.mock('@/components/shell/nav/CampaignGroups', () => ({
  CampaignGroups: ({
    groups,
    renderRow,
  }: {
    groups: { rows: { sessionId: string }[] }[]
    renderRow: (row: { sessionId: string }) => ReactNode
  }) => (
    <div data-testid="campaign-groups">
      {groups.flatMap((g) => g.rows).map((row) => renderRow(row))}
    </div>
  ),
}))
vi.mock('@/components/shell/nav/CoworkSessionMark', () => ({ SessionMark: () => null }))
vi.mock('@/components/shell/nav/OpenInSubmenu', () => ({ OpenInSubmenu: () => null }))
vi.mock('@/components/ExportMenu', () => ({
  ExportSubmenu: ({ build, extra }: { build: () => unknown; extra?: ReactNode }) => {
    return (
      <>
        <button data-testid="export-readable" onClick={() => void build()} />
        {extra}
      </>
    )
  },
}))
vi.mock('@/containers/SessionWorktreeDeleteChoice', () => ({
  SessionWorktreeDeleteChoice: () => null,
}))
vi.mock('@/containers/dialogs/FileActivityDialog', () => ({ FileActivityDialog: () => null }))
vi.mock('@/containers/dialogs/SkillsManagerDialog', () => ({ default: () => null }))
vi.mock('@/containers/dialogs/PluginsManagerDialog', () => ({ default: () => null }))
vi.mock('@/components/campaign/StartCampaignDialog', () => ({ StartCampaignDialog: () => null }))
vi.mock('@/containers/ServerSessionDialog', () => ({ ServerSessionDialog: () => null }))
vi.mock('@/stores/shared-folder-store', () => ({
  startSharedFolderSync: () => () => {},
  useSharedWith: () => 0,
}))
vi.mock('@/hooks/useHeldMail', () => ({
  useWaitingOnUser: () => false,
  useHeldMailCount: () => 0,
}))
vi.mock('@/hooks/useArchiveEnabled', () => ({ useArchiveEnabled: () => false }))
vi.mock('@/hooks/useCampaignFolder', () => ({
  useCampaignFolderState: () => ({ folder: null, isRepo: null }),
}))
vi.mock('@/hooks/useCampaigns', () => ({
  useCampaigns: () => ({
    campaigns: [
      {
        id: 'c1',
        title: 'Campaign',
        status: 'running',
        coordinatorSession: 's-coord',
        tasks: [],
      },
    ],
  }),
}))
vi.mock('@/hooks/useNestStatus', () => ({
  useCoworkNestStatus: () => () => 'none',
}))
vi.mock('@/lib/toolActivity', () => ({ loadToolActivity: async () => [] }))
vi.mock('@/lib/sessionBundle', () => ({
  buildBundle: spies.buildBundle,
  exportBundle: spies.exportBundle,
  openBundle: vi.fn(),
}))
vi.mock('@/lib/sessionHandoff', () => ({
  describeRestoreItem: vi.fn(),
  exportHandoff: spies.exportHandoff,
  restoreReport: vi.fn(),
}))
vi.mock('@/lib/exportDoc', () => ({ docFromCowork: spies.docFromCowork }))
vi.mock('@/lib/serverTransportFlag', () => ({ isServerTransport: () => false }))

import { CoworkNav } from '../CoworkNav'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'

function session(id: string, extra: Partial<CoworkSession> = {}): CoworkSession {
  return {
    id,
    title: `Session ${id}`,
    folder: null,
    updated: 1000,
    turns: [
      { id: `${id}-u`, role: 'user', content: `asked ${id}` },
      { id: `${id}-a`, role: 'assistant', content: 'reply' },
    ],
    messages: [],
    ...extra,
  } as unknown as CoworkSession
}

beforeEach(() => {
  counts.tree = 0
  counts.rows = {}
  spies.nest.length = 0
  vi.clearAllMocks()
  useCoworkSessions.setState({
    sessions: [
      session('s1'),
      session('s2', { forkedFrom: { sessionId: 's1' } as never }),
      session('s-coord', { campaign: { id: 'c1', role: 'coordinator' } as never }),
    ],
    currentId: 's1',
  })
})

describe('CoworkNav re-renders', () => {
  it('a change to a field the list does not show re-renders nothing', () => {
    render(<CoworkNav />)
    const tree = counts.tree
    const rows = { ...counts.rows }
    act(() => {
      useCoworkSessions.setState((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === 's1'
            ? ({ ...x, inFlight: { turns: [] }, runBudget: { steps: 3 } } as never)
            : x
        ),
      }))
    })
    expect(counts.tree).toBe(tree)
    expect(counts.rows).toEqual(rows)
  })

  it('a title change re-renders that row only', () => {
    render(<CoworkNav />)
    const before = { ...counts.rows }
    act(() => {
      useCoworkSessions.setState((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === 's2' ? { ...x, title: 'Renamed' } : x
        ),
      }))
    })
    expect(counts.rows['Renamed']).toBe(1)
    expect(counts.rows['Session s1']).toBe(before['Session s1'])
    expect(screen.getByText('Renamed')).toBeInTheDocument()
  })

  it('keeps campaign grouping and fork nesting', () => {
    render(<CoworkNav />)
    // The coordinator is listed in its campaign group, not in the tree.
    const group = screen.getByTestId('campaign-groups')
    expect(group).toHaveTextContent('Session s-coord')
    const treeRows = screen
      .getAllByTestId('cowork-session-item')
      .map((el) => el.getAttribute('data-session-id'))
    expect(treeRows.filter((id) => id === 's-coord')).toHaveLength(1)
    const nest = spies.nest.at(-1) as {
      parentOf: (id: string) => string | null
      updatedOf: (id: string) => number
    }
    expect(nest.parentOf('s2')).toBe('s1')
    expect(nest.parentOf('s1')).toBeNull()
    expect(nest.updatedOf('s1')).toBe(1000)
  })
})

describe('CoworkNav row actions read the full session', () => {
  it('export bundle, handoff and readable export get the stored session', async () => {
    render(<CoworkNav />)
    // A later change the row never re-rendered for must still reach the export.
    act(() => {
      useCoworkSessions.setState((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === 's1' ? ({ ...x, inFlight: { turns: [] } } as never) : x
        ),
      }))
    })
    const full = useCoworkSessions.getState().sessions.find((x) => x.id === 's1')
    const row = screen
      .getAllByTestId('cowork-session-item')
      .find((el) => el.getAttribute('data-session-id') === 's1')!
    // The row's NavItem holds its button and its menu.
    const item = row.parentElement!
    const within = (id: string) =>
      item.querySelector(`[data-testid="${id}"]`) as HTMLElement

    await act(async () => {
      fireEvent.click(within('export-session'))
    })
    expect(spies.buildBundle).toHaveBeenCalledTimes(1)
    expect(
      (spies.buildBundle.mock.calls[0][0] as { session: CoworkSession }).session
    ).toBe(full)

    await act(async () => {
      fireEvent.click(within('handoff-session'))
    })
    expect(
      (spies.buildBundle.mock.calls[1][0] as { session: CoworkSession }).session
    ).toBe(full)
    expect(spies.exportHandoff).toHaveBeenCalledTimes(1)

    fireEvent.click(within('export-readable'))
    expect(spies.docFromCowork).toHaveBeenCalledWith(full, expect.any(Date))
  })
})
