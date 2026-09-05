import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k}#${Object.values(opts).join(',')}` : k,
  }),
}))

import { CoworkWorktreeRecovery } from '../CoworkWorktreeRecovery'
import type { WorktreeRecord } from '@/hooks/useCoworkWorktrees'

const record = (path: string): WorktreeRecord => ({
  path,
  branch: 'jan/cowork/session1',
  baseSha: 'a'.repeat(40),
  sourceRoot: '/repo',
  identity: { root: '/repo', firstCommit: 'b'.repeat(40) },
  uncommittedAtCreation: [],
})

const props = (
  over: Partial<Parameters<typeof CoworkWorktreeRecovery>[0]> = {}
) => ({
  orphans: [record('/data/worktrees/a')],
  onAdopt: vi.fn(),
  onPending: vi.fn(async () => []),
  onRemove: vi.fn(async () => {}),
  ...over,
})

describe('recovering work a crashed run left behind', () => {
  it('says nothing when there is nothing left over', () => {
    render(<CoworkWorktreeRecovery {...props({ orphans: [] })} />)
    expect(screen.queryByTestId('cowork-worktree-recovery')).toBeNull()
  })

  it('adopts a worktree without making it writable', async () => {
    const p = props()
    render(<CoworkWorktreeRecovery {...p} />)

    await userEvent.click(screen.getByText('common:worktreeRecovery.use'))

    expect(p.onAdopt).toHaveBeenCalledWith(p.orphans[0])
    // Nothing here issues a grant, and the component says so rather than
    // leaving the user to assume it resumed where they left off.
    expect(screen.getByTestId('cowork-worktree-recovery')).toHaveTextContent(
      'common:worktreeRecovery.noAuthority'
    )
  })

  it('names the files a removal would destroy before removing anything', async () => {
    const p = props({ onPending: vi.fn(async () => ['a.ts', 'b.ts']) })
    render(<CoworkWorktreeRecovery {...p} />)

    await userEvent.click(screen.getByText('common:worktreeRecovery.remove'))

    expect(p.onRemove).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('a.ts, b.ts')

    await userEvent.click(
      screen.getByText('common:worktreeRecovery.confirmRemove')
    )
    // Forced only because the list was shown: this is the click that saw it.
    expect(p.onRemove).toHaveBeenCalledWith(p.orphans[0], true)
  })

  it('does not claim uncommitted work when there is none', async () => {
    const p = props()
    render(<CoworkWorktreeRecovery {...p} />)

    await userEvent.click(screen.getByText('common:worktreeRecovery.remove'))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'common:worktreeRecovery.confirmClean'
    )

    await userEvent.click(
      screen.getByText('common:worktreeRecovery.confirmRemove')
    )
    expect(p.onRemove).toHaveBeenCalledWith(p.orphans[0], false)
  })

  it('leaves the worktree alone when the confirmation is dismissed', async () => {
    const p = props()
    render(<CoworkWorktreeRecovery {...p} />)

    await userEvent.click(screen.getByText('common:worktreeRecovery.remove'))
    await userEvent.click(screen.getByText('common:worktreeRecovery.cancel'))

    expect(p.onRemove).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
