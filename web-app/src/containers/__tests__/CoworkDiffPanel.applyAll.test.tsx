import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) =>
      vars ? `${k} ${JSON.stringify(vars)}` : k,
  }),
}))
vi.mock('@/components/DiffView', () => ({
  DiffView: ({ diff }: { diff: string }) => <pre>{diff}</pre>,
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { CoworkDiffPanel } from '../CoworkDiffPanel'
import type { CoworkFileDiff } from '@/lib/coworkDiffs'
import type { CoworkGitState } from '@/hooks/useCoworkGitStatus'
import type { SandboxApplyActions } from '../CoworkApplyAllDialog'

const file = (path: string): CoworkFileDiff => ({
  path,
  additions: 1,
  deletions: 0,
  operations: [{ diff: '+ x', source: 'main' }],
})
const noGit: CoworkGitState = {
  scope: 'working',
  setScope: vi.fn(),
  status: null,
  loading: false,
  error: undefined,
  nonce: 0,
  refresh: vi.fn(),
}
const plan = (path: string) => ({
  source: path,
  folder: '/home/user/proj',
  destination: path,
  remapped: false,
})

function setup(over: Partial<SandboxApplyActions> = {}) {
  const actions: SandboxApplyActions = {
    planFor: (p) => (p === 'skip.md' ? null : plan(p)),
    probe: vi.fn(async (p: string) => (p === 'mine.md' ? 'differs' : 'new') as 'new' | 'differs'),
    apply: vi.fn(async () => 'created' as const),
    ...over,
  }
  const onOpenFile = vi.fn()
  const onOpenExternal = vi.fn()
  render(
    <CoworkDiffPanel
      sandboxFiles={[file('new.md'), file('mine.md'), file('skip.md')]}
      folder={null}
      git={noGit}
      onClose={vi.fn()}
      onApplyFile={actions.apply}
      applyPlanFor={actions.planFor}
      applyActions={actions}
      onOpenFile={onOpenFile}
      onOpenExternal={onOpenExternal}
    />
  )
  return { actions, onOpenFile, onOpenExternal }
}

describe('Apply all to folder', () => {
  it('lists every file with its destination, overwrites unticked, then applies the ticked ones', async () => {
    const user = userEvent.setup()
    const { actions } = setup()
    await user.click(screen.getByTestId('apply-all'))
    const dialog = await screen.findByTestId('cowork-apply-all-dialog')
    const rows = await within(dialog).findAllByTestId('apply-all-row')
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['apply', 'apply', 'skip'])
    expect(within(rows[0]).getByText('→ proj/new.md')).toBeInTheDocument()
    const [fresh, mine] = within(dialog).getAllByRole('checkbox') as HTMLInputElement[]
    expect(fresh.checked).toBe(true)
    expect(mine.checked).toBe(false)
    expect(within(rows[1]).getByText('common:changes.applyAllOverwrites')).toBeInTheDocument()
    expect(within(rows[2]).getByText(/common:changes.applyAllSkipped/)).toBeInTheDocument()

    await user.click(mine)
    await user.click(within(dialog).getByTestId('apply-all-confirm'))
    expect(actions.apply).toHaveBeenNthCalledWith(1, 'new.md', false)
    expect(actions.apply).toHaveBeenNthCalledWith(2, 'mine.md', true)
    expect(await within(dialog).findAllByText('common:changes.applyCreated')).toHaveLength(2)
    expect(toast.success).toHaveBeenCalledWith(
      'common:changes.applyAllSummary {"applied":2,"failed":0}'
    )
  })

  it('offers no Apply all when nothing can be applied', () => {
    render(
      <CoworkDiffPanel
        sandboxFiles={[file('a.md')]}
        folder={null}
        git={noGit}
        onClose={vi.fn()}
        applyActions={{ planFor: () => null, probe: vi.fn(), apply: vi.fn() }}
      />
    )
    expect(screen.queryByTestId('apply-all')).toBeNull()
  })
})

describe('Changes rows', () => {
  it('opens a file from its name, and outside Flint from its own action', async () => {
    const user = userEvent.setup()
    const { onOpenFile, onOpenExternal } = setup()
    const [name] = screen.getAllByTestId('changes-open-path')
    await user.click(name)
    expect(onOpenFile).toHaveBeenCalledWith('new.md')
    // The name opens the file; it does not also expand the row.
    expect(screen.queryByText('+ x')).toBeNull()
    await user.click(screen.getAllByTestId('changes-open-external')[0])
    expect(onOpenExternal).toHaveBeenCalledWith('new.md', 'session')
  })
})
