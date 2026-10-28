import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

/* eslint-disable @typescript-eslint/no-explicit-any */
const m = vi.hoisted(() => ({
  chat: null as null | Record<string, any>,
  stop: null as null | Record<string, any>,
  recovery: null as null | Record<string, any>,
  ready: null as null | Record<string, any>,
  strip: null as null | Record<string, any>,
  worktreeBar: null as null | Record<string, any>,
}))

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
vi.mock('@/containers/ChatInput', () => ({
  default: (p: Record<string, any>) => {
    m.chat = p
    return (
      <div data-testid="chat">
        {p.stopControl}
        {p.surfaceControls}
      </div>
    )
  },
}))
vi.mock('@/containers/CoworkStopMenu', () => ({
  CoworkStopMenu: (p: Record<string, any>) => {
    m.stop = p
    return <i data-testid="stop-menu" />
  },
}))
vi.mock('@/containers/CoworkWorktreeRecovery', () => ({
  CoworkWorktreeRecovery: (p: Record<string, any>) => {
    m.recovery = p
    return <i data-testid="recovery" />
  },
}))
vi.mock('@/containers/CoworkReviewReady', () => ({
  CoworkReviewReady: (p: Record<string, any>) => {
    m.ready = p
    return <i data-testid="ready" />
  },
}))
vi.mock('@/containers/CoworkSessionWorktreeBar', () => ({
  CoworkSessionWorktreeBar: (p: Record<string, any>) => {
    m.worktreeBar = p
    return <i data-testid="worktree-bar" />
  },
}))
vi.mock('@/containers/NarrowStatusStrip', () => ({
  NarrowBarsSheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  NarrowStatusStrip: (p: Record<string, any>) => {
    m.strip = p
    return <i data-testid="strip" />
  },
}))
vi.mock('@/containers/CoworkBarStack', () => ({
  CoworkBarStack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/containers/CoworkHandoffNotice', () => ({ CoworkHandoffNotice: () => null }))
vi.mock('@/containers/CoworkProjectInit', () => ({ CoworkProjectInit: () => null }))
vi.mock('@/containers/CoworkSandboxChip', () => ({ CoworkSandboxChip: () => null }))
vi.mock('@/containers/FolderTrustBanner', () => ({ FolderTrustBanner: () => null }))
vi.mock('@/containers/JevSkillSuggestion', () => ({ JevSkillSuggestion: () => null }))
vi.mock('@/containers/PrBar', () => ({ PrBar: () => null }))
vi.mock('@/containers/SharedFolderBar', () => ({ SharedFolderBar: () => null }))
vi.mock('@/containers/SharedFolderIsolationHint', () => ({ SharedFolderIsolationHint: () => null }))
vi.mock('@/containers/SkillSelector', () => ({ default: () => null }))
vi.mock('@/lib/approvalDestination', () => ({ scrollToApproval: vi.fn() }))

import { CoworkComposerArea } from '../CoworkComposerArea'

const props = (over: Record<string, unknown> = {}) =>
  ({
    paneChrome: null,
    folder: '/proj',
    recoveryHiddenHere: true,
    worktree: undefined,
    session: { id: 's1', title: 'T', turns: [{}], handoff: undefined },
    effective: { downgradedFrom: undefined, access: 'review' },
    foundWorktrees: [],
    coworkSessionIds: [],
    heldWorktreePaths: [],
    setRecoveryHiddenHere: vi.fn(),
    serviceHub: {},
    setFoundWorktrees: vi.fn(),
    changeCounts: { fileCount: 2, additions: 5, deletions: 1 },
    openRail: vi.fn(),
    running: false,
    fileDiffs: [{ path: 'a.ts' }],
    sandboxApply: undefined,
    autoWorktree: { isGit: true, workOnCopy: vi.fn(), isolationReason: null },
    capabilityState: { known: true, managedWorktree: true },
    handleSubmit: vi.fn(),
    treeRoot: '/proj',
    stripMode: false,
    barsSheetOpen: false,
    setBarsSheetOpen: vi.fn(),
    setBarsSummary: vi.fn(),
    waitingIds: [],
    barsSummary: {},
    gitBranch: 'main',
    phoneStrip: false,
    projectInitOpen: false,
    setProjectInitOpen: vi.fn(),
    projectInitRoot: null,
    projectInitOffered: false,
    setInstructionsVersion: vi.fn(),
    coworkPane: { draftScope: 'pane1' },
    composerModel: { selection: { selectedProvider: 'p', selectedModel: 'm' }, unavailable: null },
    confirmSessionModel: vi.fn(),
    applyFolders: [],
    attachFolder: vi.fn(),
    referenceSources: { skills: [], agents: [] },
    slashBuiltins: [],
    handleStop: vi.fn(),
    currentRunId: 'run1',
    handleStopAll: vi.fn(),
    tokenSource: {},
    compactNowRef: { current: vi.fn() },
    paneSessionIdRef: { current: undefined },
    belowComposerControls: <i />,
    quietModelSelector: <i />,
    showComposerRailButtons: false,
    phone: false,
    railToolbar: vi.fn(() => <i data-testid="rail-toolbar" />),
    ...over,
  }) as never

describe('CoworkComposerArea', () => {
  beforeEach(() => {
    for (const k of Object.keys(m) as (keyof typeof m)[]) m[k] = null
  })

  it('feeds the composer the session scope and the run state', () => {
    const p: any = props({ running: true })
    render(<CoworkComposerArea {...p} />)
    expect(m.chat?.scopeKey).toBe('s1')
    expect(m.chat?.draftScope).toBe('pane1')
    expect(m.chat?.chatStatus).toBe('streaming')
    expect(m.chat?.onSubmit).toBe(p.handleSubmit)
    expect(m.chat?.onStop).toBe(p.handleStop)
    expect(m.stop).toMatchObject({ running: true, sessionId: 's1', runId: 'run1' })
  })

  it('compacts through the ref and attaches a pasted folder', () => {
    const p: any = props()
    render(<CoworkComposerArea {...p} />)
    m.chat?.onCompact()
    expect(p.compactNowRef.current).toHaveBeenCalled()
    m.chat?.pastedFolder.onAttach('/x')
    expect(p.attachFolder).toHaveBeenCalledWith('/x')
  })

  it('shows the review-ready bar with the change counts and opens the diff rail', () => {
    const p: any = props()
    render(<CoworkComposerArea {...p} />)
    expect(m.ready).toMatchObject({ fileCount: 2, additions: 5, deletions: 1, sandboxPaths: ['a.ts'] })
    m.ready?.onReview()
    expect(p.openRail).toHaveBeenCalledWith({ kind: 'diff' })
  })

  it('offers worktree recovery only before the first turn and while not hidden', () => {
    const { unmount } = render(<CoworkComposerArea {...(props() as any)} />)
    expect(screen.queryByTestId('recovery')).toBeNull()
    unmount()
    render(
      <CoworkComposerArea
        {...(props({
          recoveryHiddenHere: false,
          session: { id: 's1', title: 'T', turns: [], handoff: undefined },
        }) as any)}
      />
    )
    expect(screen.getByTestId('recovery')).toBeTruthy()
  })

  it('creates a pull request through the session prompt', () => {
    const p: any = props()
    render(<CoworkComposerArea {...p} />)
    m.worktreeBar?.onCreatePr('feat', 'main')
    expect(p.handleSubmit).toHaveBeenCalledTimes(1)
    expect(String(p.handleSubmit.mock.calls[0][0])).toContain('feat')
  })

  it('shows the narrow status strip only in strip mode', () => {
    const { unmount } = render(<CoworkComposerArea {...(props() as any)} />)
    expect(screen.queryByTestId('strip')).toBeNull()
    unmount()
    render(<CoworkComposerArea {...(props({ stripMode: true, branch: undefined }) as any)} />)
    expect(m.strip?.branch).toBe('main')
    expect(m.strip?.files).toEqual({ count: 2, additions: 5, deletions: 1 })
  })

  it('puts the rail toolbar in the composer only when asked and not on a phone', () => {
    const { unmount } = render(<CoworkComposerArea {...(props() as any)} />)
    expect(screen.queryByTestId('rail-toolbar')).toBeNull()
    unmount()
    render(<CoworkComposerArea {...(props({ showComposerRailButtons: true }) as any)} />)
    expect(screen.getByTestId('rail-toolbar')).toBeTruthy()
  })
})
