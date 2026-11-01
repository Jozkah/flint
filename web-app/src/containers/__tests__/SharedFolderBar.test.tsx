import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o ? `${k} ${JSON.stringify(o)}` : k,
  }),
}))

const { peers, allow, listen } = vi.hoisted(() => ({
  peers: vi.fn(),
  allow: vi.fn(),
  listen: vi.fn(),
}))
vi.mock('@/lib/sharedFolder', () => ({
  SHARED_FOLDER_UPDATED_EVENT: 'agent-shared-folder-updated',
  sharedFolder: { peers, allow },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ events: () => ({ listen }) }),
}))

import {
  SHARED_FILES_SHOWN,
  SharedFolderBar,
  formatRemaining,
  summarizeShared,
} from '../SharedFolderBar'
import type { SharedFolderView, SharedPeer } from '@/lib/sharedFolder'

const t = (k: string, o?: Record<string, unknown>) =>
  o ? `${k} ${JSON.stringify(o)}` : k

const peer = (id: string, over: Partial<SharedPeer> = {}): SharedPeer => ({
  sessionId: id,
  displayName: `Session ${id}`,
  status: 'running',
  waitingApproval: false,
  access: 'direct',
  isolated: false,
  branch: 'feat/x',
  startBranch: 'feat/x',
  startHead: 'abc',
  lastActivity: 1,
  recentFiles: [],
  claims: [],
  ...over,
})

const view = (over: Partial<SharedFolderView> = {}): SharedFolderView => ({
  folderKey: 'c:/repo',
  folder: 'C:\\repo',
  git: true,
  branch: 'feat/x',
  you: peer('me', { displayName: 'Mine' }),
  others: [peer('a')],
  holds: [],
  allowances: [],
  ...over,
})

async function mount(v: SharedFolderView | null) {
  peers.mockResolvedValue(v)
  const onOpen = vi.fn()
  const out = render(<SharedFolderBar sessionId="me" onOpenSession={onOpen} />)
  await act(async () => {
    await Promise.resolve()
  })
  return { onOpen, ...out }
}

beforeEach(() => {
  peers.mockReset()
  allow.mockReset().mockResolvedValue(null)
  listen.mockReset().mockResolvedValue(() => {})
})
afterEach(() => vi.useRealTimers())

describe('summarizeShared', () => {
  it('ranks a hold over a branch change over waiting over calm', () => {
    const base = view({
      you: peer('me', { startBranch: 'main' }),
      others: [peer('a', { waitingApproval: true })],
    })
    expect(summarizeShared(base, t).kind).toBe('branch')
    expect(
      summarizeShared(
        { ...base, holds: [{ kind: 'edit', target: 'src/x.ts', ownerId: 'a', ownerName: 'A', at: 1 }] },
        t
      ).kind
    ).toBe('hold')
    expect(summarizeShared({ ...base, you: peer('me') }, t).kind).toBe('waiting')
    const calm = summarizeShared(view(), t)
    expect(calm).toMatchObject({ kind: 'calm', urgent: false })
  })

  it('an isolated session sees no branch change', () => {
    const v = view({ you: peer('me', { isolated: true, startBranch: 'main' }) })
    expect(summarizeShared(v, t).kind).toBe('calm')
  })

  it('formats the time left as m:ss', () => {
    expect(formatRemaining(90_500, 0)).toBe('1:31')
    expect(formatRemaining(0, 5)).toBe('0:00')
  })
})

describe('SharedFolderBar', () => {
  it('renders nothing when alone, without a folder, or without a backend', async () => {
    await mount(view({ others: [] }))
    expect(screen.queryByTestId('shared-folder-bar')).toBeNull()
  })

  it('degrades silently when the commands are not there', async () => {
    peers.mockRejectedValue(new Error('no command'))
    render(<SharedFolderBar sessionId="me" onOpenSession={() => {}} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('shared-folder-bar')).toBeNull()
  })

  it('counts only running sessions as working, idle ones as open', () => {
    const mixed = view({
      others: [peer('a'), peer('b', { status: 'idle' }), peer('c', { status: 'idle' })],
    })
    expect(summarizeShared(mixed, t).text).toBe(
      'common:sharedFolder.others {"count":1}'
    )
    const idle = view({
      others: [peer('b', { status: 'idle' }), peer('c', { status: 'idle' })],
    })
    expect(summarizeShared(idle, t).text).toBe(
      'common:sharedFolder.othersIdle {"count":2}'
    )
  })

  it('shows one quiet row with the count and the names', async () => {
    await mount(view({ others: [peer('a'), peer('b')] }))
    const bar = screen.getByTestId('shared-folder-bar')
    expect(bar).toHaveAttribute('data-kind', 'calm')
    expect(bar).not.toHaveAttribute('data-shared-urgent')
    expect(bar).toHaveAttribute('data-shared-count', '2')
    expect(screen.getByTestId('shared-folder-text')).toHaveTextContent(
      'common:sharedFolder.others {"count":2}'
    )
    expect(bar).toHaveTextContent('Session a, Session b')
    // Collapsed: no details until the chevron is pressed.
    expect(screen.queryByTestId('shared-folder-details')).toBeNull()
  })

  it('says a hold in words and marks the bar urgent', async () => {
    await mount(
      view({
        holds: [
          { kind: 'edit', target: 'src/x.ts', ownerId: 'a', ownerName: 'Fix auth', at: 1 },
        ],
      })
    )
    expect(screen.getByTestId('shared-folder-bar')).toHaveAttribute('data-kind', 'hold')
    expect(screen.getByTestId('shared-folder-bar')).toHaveAttribute('data-shared-urgent')
    expect(screen.getByTestId('shared-folder-text')).toHaveTextContent(
      '"owner":"Fix auth","target":"src/x.ts","session":"Mine"'
    )
  })

  it('says a branch change under the session', async () => {
    await mount(view({ branch: 'feat/y', you: peer('me', { startBranch: 'feat/x' }) }))
    expect(screen.getByTestId('shared-folder-text')).toHaveTextContent(
      'common:sharedFolder.branchChanged {"from":"feat/x","to":"feat/y"}'
    )
  })

  it('counts peers waiting for approval', async () => {
    await mount(
      view({ others: [peer('a', { waitingApproval: true }), peer('b', { waitingApproval: true })] })
    )
    expect(screen.getByTestId('shared-folder-text')).toHaveTextContent(
      'common:sharedFolder.waitingApproval {"count":2}'
    )
  })

  it('lists each peer with state, branch, isolation, files and claims', async () => {
    const files = Array.from({ length: SHARED_FILES_SHOWN + 2 }, (_, i) => ({
      path: `src/f${i}.ts`,
      at: i,
    }))
    const { onOpen } = await mount(
      view({
        others: [
          peer('a', { recentFiles: files, claims: ['src/f0.ts'], waitingApproval: true }),
          peer('b', { isolated: true, branch: null, status: 'idle' }),
        ],
      })
    )
    fireEvent.click(screen.getByTestId('shared-folder-toggle'))
    const rows = screen.getAllByTestId('shared-peer')
    expect(rows).toHaveLength(2)
    const first = rows[0]
    expect(first.querySelector('[data-testid="shared-peer-dot"]')).toHaveAttribute(
      'data-state',
      'waiting'
    )
    expect(first.querySelector('[data-testid="shared-peer-branch"]')).toHaveTextContent('feat/x')
    expect(first.querySelector('[data-testid="shared-peer-files"]')!.textContent).toContain(
      'src/f4.ts'
    )
    expect(first.querySelector('[data-testid="shared-peer-files"]')!.textContent).not.toContain(
      'src/f5.ts'
    )
    expect(first.querySelector('[data-testid="shared-peer-files-more"]')).toHaveTextContent(
      'common:sharedFolder.moreFiles {"count":2}'
    )
    expect(first.querySelector('[data-testid="shared-peer-claims"]')).toHaveTextContent(
      'src/f0.ts'
    )
    expect(rows[1].querySelector('[data-testid="shared-peer-isolated"]')).not.toBeNull()
    expect(rows[1].querySelector('[data-testid="shared-peer-branch"]')).toBeNull()

    // The name and the Message action both open that session.
    fireEvent.click(first.querySelector('[data-testid="shared-peer-open"]')!)
    fireEvent.click(rows[1].querySelector('[data-testid="shared-peer-message"]')!)
    expect(onOpen).toHaveBeenNthCalledWith(1, 'a')
    expect(onOpen).toHaveBeenNthCalledWith(2, 'b')
  })

  it('lets the user allow an edit anyway, and a branch switch for a git hold', async () => {
    await mount(
      view({
        holds: [
          { kind: 'edit', target: 'src/x.ts', ownerId: 'a', ownerName: 'A', at: 1 },
          { kind: 'git', target: 'checkout', ownerId: 'a', ownerName: 'A', at: 1 },
        ],
      })
    )
    fireEvent.click(screen.getByTestId('shared-folder-toggle'))
    const [edit, git] = screen.getAllByTestId('shared-allow')
    fireEvent.click(edit)
    expect(allow).toHaveBeenLastCalledWith('me', 'edit')
    fireEvent.click(git)
    expect(allow).toHaveBeenLastCalledWith('me', 'git')
  })

  it('shows an allowance with a countdown and withdraws it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 19, 12, 0, 0))
    const until = Date.now() + 125_000
    peers.mockResolvedValue(
      view({
        holds: [{ kind: 'edit', target: 'src/x.ts', ownerId: 'a', ownerName: 'A', at: 1 }],
        allowances: [{ scope: 'edit', until }],
      })
    )
    render(<SharedFolderBar sessionId="me" onOpenSession={() => {}} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    fireEvent.click(screen.getByTestId('shared-folder-toggle'))
    expect(screen.getByTestId('shared-allowance-left')).toHaveTextContent('2:05')
    // Already allowed: no second button for the same thing.
    expect(screen.queryByTestId('shared-allow')).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByTestId('shared-allowance-left')).toHaveTextContent('2:00')
    fireEvent.click(screen.getByTestId('shared-allowance-withdraw'))
    expect(allow).toHaveBeenLastCalledWith('me', 'edit', 0)
  })

  it('reads again, debounced, when an update for its folder arrives', async () => {
    vi.useFakeTimers()
    peers.mockResolvedValue(view())
    render(<SharedFolderBar sessionId="me" onOpenSession={() => {}} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(peers).toHaveBeenCalledTimes(1)
    const handler = listen.mock.calls[0][1] as (e: { payload: unknown }) => void
    // Another folder: ignored. Three of ours in a burst: one read.
    handler({ payload: { folderKey: 'c:/other', sessionId: 'z', reason: 'state' } })
    for (let i = 0; i < 3; i++)
      handler({ payload: { folderKey: 'c:/repo', sessionId: 'a', reason: 'claim' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(peers).toHaveBeenCalledTimes(2)
  })
})
