import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) =>
      vars ? `${k} ${JSON.stringify(vars)}` : k,
  }),
}))

vi.mock('@/components/DiffView', () => ({
  DiffView: ({ diff }: { diff: string }) => <pre data-testid="diff">{diff}</pre>,
}))

vi.mock('@/lib/coworkGit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/coworkGit')>()
  return {
    ...actual,
    loadGitFileDiff: vi.fn().mockResolvedValue({
      diff: '@@ -0,0 +1 @@\n+added by git',
      binary: false,
      truncated: false,
    }),
  }
})

import { CoworkDiffPanel } from '../CoworkDiffPanel'
import type { CoworkFileDiff } from '@/lib/coworkDiffs'
import type { CoworkGitState } from '@/hooks/useCoworkGitStatus'
import type { GitStatus } from '@/lib/coworkGit'

const sandboxFiles: CoworkFileDiff[] = [
  {
    path: 'report.md',
    additions: 5,
    deletions: 2,
    operations: [{ diff: '+ new line', source: 'main' }],
  },
  {
    path: 'chart.py',
    additions: 1,
    deletions: 0,
    operations: [
      { diff: '+ import numpy', source: 'subagent', sourceName: 'researcher' },
    ],
  },
]

const noGit: CoworkGitState = {
  scope: 'working',
  setScope: vi.fn(),
  status: null,
  loading: false,
  error: undefined,
  nonce: 0,
  refresh: vi.fn(),
}

function gitWith(status: GitStatus, over: Partial<CoworkGitState> = {}): CoworkGitState {
  return { ...noGit, status, ...over }
}

describe('CoworkDiffPanel', () => {
  it('summarises the totals across sandbox files when no folder is attached', () => {
    render(
      <CoworkDiffPanel
        sandboxFiles={sandboxFiles}
        folder={null}
        git={noGit}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('+6 -2')).toBeInTheDocument()
  })

  it('shows a lone sandbox source without section headers', () => {
    render(
      <CoworkDiffPanel
        sandboxFiles={sandboxFiles}
        folder={null}
        git={noGit}
        onClose={vi.fn()}
      />
    )
    expect(
      screen.queryByText('common:changes.sandboxOutput')
    ).toBeNull()
    expect(
      screen.queryByText('common:changes.projectWorkingTree')
    ).toBeNull()
  })

  it('reveals a sandbox file’s hunks only once it is expanded', async () => {
    render(
      <CoworkDiffPanel
        sandboxFiles={sandboxFiles}
        folder={null}
        git={noGit}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByTestId('diff')).toBeNull()
    await userEvent.click(screen.getByText('report.md'))
    expect(screen.getByTestId('diff')).toHaveTextContent('+ new line')
  })

  it('attributes a subagent’s edit to it', async () => {
    render(
      <CoworkDiffPanel
        sandboxFiles={sandboxFiles}
        folder={null}
        git={noGit}
        onClose={vi.fn()}
      />
    )
    await userEvent.click(screen.getByText('chart.py'))
    expect(screen.getByText('researcher')).toBeInTheDocument()
  })

  it('labels both sources when the repo and the sandbox each have changes', () => {
    const status: GitStatus = {
      branch: 'main',
      repoRoot: '/home/user/proj',
      additions: 3,
      deletions: 1,
      files: [
        {
          path: 'src/a.ts',
          origPath: null,
          status: 'modified',
          staged: false,
          unstaged: true,
          additions: 3,
          deletions: 1,
          binary: false,
        },
      ],
    }
    render(
      <CoworkDiffPanel
        sandboxFiles={sandboxFiles}
        folder="/home/user/proj"
        git={gitWith(status)}
        onClose={vi.fn()}
      />
    )
    expect(
      screen.getByText('common:changes.projectWorkingTree')
    ).toBeInTheDocument()
    expect(screen.getByText('common:changes.sandboxOutput')).toBeInTheDocument()
    // Combined totals: git 3/1 + sandbox 6/2.
    expect(screen.getByText('+9 -3')).toBeInTheDocument()
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
  })

  it('loads a project file diff lazily on expand', async () => {
    const status: GitStatus = {
      branch: 'main',
      repoRoot: '/home/user/proj',
      additions: 3,
      deletions: 1,
      files: [
        {
          path: 'src/a.ts',
          origPath: null,
          status: 'modified',
          staged: false,
          unstaged: true,
          additions: 3,
          deletions: 1,
          binary: false,
        },
      ],
    }
    render(
      <CoworkDiffPanel
        sandboxFiles={[]}
        folder="/home/user/proj"
        git={gitWith(status)}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByTestId('diff')).toBeNull()
    await userEvent.click(screen.getByText('src/a.ts'))
    expect(await screen.findByTestId('diff')).toHaveTextContent('added by git')
  })

  it('reports a clean working tree for an attached repo with no changes', () => {
    const status: GitStatus = {
      branch: 'main',
      repoRoot: '/home/user/proj',
      additions: 0,
      deletions: 0,
      files: [],
    }
    render(
      <CoworkDiffPanel
        sandboxFiles={[]}
        folder="/home/user/proj"
        git={gitWith(status)}
        onClose={vi.fn()}
      />
    )
    expect(
      screen.getByText('common:changes.cleanWorkingTree')
    ).toBeInTheDocument()
  })

  it('says the folder is not a repo when status is null', () => {
    render(
      <CoworkDiffPanel
        sandboxFiles={[]}
        folder="/home/user/plain"
        git={noGit}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('common:changes.noRepo')).toBeInTheDocument()
  })

  it('says what will appear here when nothing has changed anywhere', () => {
    render(
      <CoworkDiffPanel
        sandboxFiles={[]}
        folder={null}
        git={noGit}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('common:changes.empty')).toBeInTheDocument()
  })
})
