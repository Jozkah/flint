import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

const captured = vi.hoisted(() => ({ panel: null as null | Record<string, unknown> }))

vi.mock('@/containers/CoworkDiffPanel', () => ({
  CoworkDiffPanel: (props: Record<string, unknown>) => {
    captured.panel = props
    return (
      <div data-testid="panel">
        <div data-testid="header">{props.header as ReactNode}</div>
        <div data-testid="footer">{props.footer as ReactNode}</div>
      </div>
    )
  },
}))
vi.mock('@/containers/CoworkProposalReview', () => ({ CoworkProposalReview: () => <i data-testid="proposal" /> }))
vi.mock('@/components/server/RemoteWorktreePanel', () => ({ RemoteWorktreePanel: () => <i data-testid="remote" /> }))
vi.mock('@/containers/CoworkReviewAction', () => ({ CoworkReviewAction: () => <i data-testid="review" /> }))
vi.mock('@/containers/CoworkTeamReviews', () => ({ CoworkTeamReviews: () => <i data-testid="team" /> }))
vi.mock('@/containers/CoworkTurnUndo', () => ({ CoworkTurnUndo: () => <i data-testid="undo" /> }))
vi.mock('@/containers/CoworkRewind', () => ({ CoworkRewind: () => <i data-testid="rewind" /> }))
vi.mock('@/containers/CoworkBundleImport', () => ({ CoworkBundleImport: () => <i data-testid="bundle" /> }))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => ({}) }))
vi.mock('@/hooks/useCoworkCheckpoints', () => ({
  useCoworkCheckpoints: { getState: () => ({ usable: () => [] }) },
}))

import { CoworkDiffRail } from '../CoworkDiffRail'

const base = {
  sessionId: 's1',
  sessionRemote: false,
  folder: '/proj',
  worktree: null,
  git: { refresh: vi.fn() },
  onSendPrompt: vi.fn(() => true),
  reviewFocusTaskId: null,
  writeGrant: undefined,
  running: false,
  hasCheckpoints: false,
  treeRoot: '/proj',
  access: 'workspace',
  janAuthored: [],
  gitBranch: 'main',
  fileDiffs: [],
  openToolPath: vi.fn(),
  workspacePath: '/proj',
  applyFolders: [],
  sandboxApply: undefined,
  displayToolPath: (p: string) => p,
  resolveToolPath: vi.fn(),
  pathLinkRoots: ['/proj'],
  origins: undefined,
  focusPath: undefined,
  onClose: vi.fn(),
}

const show = (over: Record<string, unknown> = {}) =>
  render(<CoworkDiffRail {...(base as never)} {...(over as never)} />)

describe('CoworkDiffRail', () => {
  beforeEach(() => {
    captured.panel = null
  })

  it('feeds the panel its branch, project name and tree', () => {
    show()
    expect(captured.panel?.branch).toBe('main')
    expect(captured.panel?.projectName).toBe('proj')
    expect(captured.panel?.folder).toBe('/proj')
  })

  it('prefers the worktree branch', () => {
    show({ worktree: { branch: 'flint/x', path: '/w', sourceRoot: '/proj' } })
    expect(captured.panel?.branch).toBe('flint/x')
    expect(screen.getByTestId('proposal')).toBeTruthy()
  })

  it('shows the review tools for a folder session and the remote panel only for remote ones', () => {
    const { unmount } = show()
    expect(screen.getByTestId('review')).toBeTruthy()
    expect(screen.getByTestId('team')).toBeTruthy()
    expect(screen.getByTestId('bundle')).toBeTruthy()
    expect(screen.getByTestId('undo')).toBeTruthy()
    expect(screen.getByTestId('rewind')).toBeTruthy()
    expect(screen.queryByTestId('remote')).toBeNull()
    unmount()
    show({ sessionRemote: true })
    expect(screen.getByTestId('remote')).toBeTruthy()
  })

  it('hides session tools without a session and review tools without a folder', () => {
    show({ sessionId: undefined, folder: null })
    for (const id of ['review', 'team', 'bundle', 'undo', 'remote', 'proposal'])
      expect(screen.queryByTestId(id)).toBeNull()
    expect(screen.getByTestId('rewind')).toBeTruthy()
  })

  it('answers whether a path is in the sandbox', () => {
    show({ workspacePath: '/proj/.sandbox' })
    const isSandbox = captured.panel?.isSandboxPath as (p: string) => boolean
    expect(typeof isSandbox('/elsewhere/file.ts')).toBe('boolean')
  })
})
