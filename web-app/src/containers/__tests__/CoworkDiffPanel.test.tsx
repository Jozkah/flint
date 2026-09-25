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
    expect(screen.getByTestId('changes-total')).toHaveTextContent('+6−2')
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
    expect(screen.getByTestId('changes-total')).toHaveTextContent('+9−3')
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

/**
 * Git says these files differ. It does not say who made them differ.
 *
 * Without the ledger every row here reads as the agent's work, which is how a
 * user's own uncommitted changes get handed back to them as Jan's.
 */
describe('what the Changes panel claims about each file', () => {
  const status: GitStatus = {
    branch: 'main',
    repoRoot: '/repo',
    files: [
      {
        path: 'mine.ts',
        origPath: null,
        status: 'modified',
        staged: false,
        unstaged: true,
        additions: 1,
        deletions: 0,
        binary: false,
      },
      {
        path: 'theirs.ts',
        origPath: null,
        status: 'modified',
        staged: false,
        unstaged: true,
        additions: 1,
        deletions: 0,
        binary: false,
      },
      {
        path: 'built.js',
        origPath: null,
        status: 'untracked',
        staged: false,
        unstaged: true,
        additions: 0,
        deletions: 0,
        binary: false,
      },
    ],
    additions: 2,
    deletions: 0,
  }

  const show = (origins?: Parameters<typeof CoworkDiffPanel>[0]['origins']) =>
    render(
      <CoworkDiffPanel
        sandboxFiles={[]}
        folder="/repo"
        git={gitWith(status)}
        origins={origins}
        onClose={vi.fn()}
      />
    )

  it('labels each row with what is actually known about it', () => {
    show([
      {
        path: 'mine.ts',
        destination: 'repository',
        evidence: 'jan-write',
        alsoPreExisting: false,
      },
      {
        path: 'theirs.ts',
        destination: 'repository',
        evidence: 'pre-existing',
        alsoPreExisting: false,
      },
      {
        path: 'built.js',
        destination: 'repository',
        evidence: 'observed-in-run',
        alsoPreExisting: false,
      },
    ])

    expect(
      screen.getByText('common:coworkOrigins.row.jan-write')
    ).toBeInTheDocument()
    expect(
      screen.getByText('common:coworkOrigins.row.pre-existing')
    ).toBeInTheDocument()
    expect(
      screen.getByText('common:coworkOrigins.row.observed-in-run')
    ).toBeInTheDocument()
  })

  it('says so when Jan wrote over changes that were already there', () => {
    show([
      {
        path: 'mine.ts',
        destination: 'repository',
        evidence: 'jan-write',
        alsoPreExisting: true,
      },
    ])

    expect(
      screen.getByText('common:coworkOrigins.row.jan-write-over')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('common:coworkOrigins.row.jan-write')
    ).toBeNull()
  })

  // Before any run there is no ledger. Labelling nothing is right; labelling
  // everything as Jan's would not be.
  it('claims nothing about a session that has not run', () => {
    show()

    expect(screen.getByText('mine.ts')).toBeInTheDocument()
    expect(
      screen.queryByText('common:coworkOrigins.row.jan-write')
    ).toBeNull()
    expect(
      screen.queryByText('common:coworkOrigins.row.observed-in-run')
    ).toBeNull()
  })
})
