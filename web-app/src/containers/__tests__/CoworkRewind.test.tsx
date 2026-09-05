import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k}#${Object.values(opts).join(',')}` : k,
  }),
}))

import { CoworkRewind } from '../CoworkRewind'
import type { CheckpointEntry } from '@/hooks/useCoworkCheckpoints'

const point = (over: Partial<CheckpointEntry> = {}): CheckpointEntry => ({
  sha: 'a'.repeat(40),
  label: 'rename the parser',
  destination: 'managed',
  root: '/data/worktrees/s1',
  at: 1,
  access: 'managed-worktree',
  ...over,
})

const props = (over: Partial<Parameters<typeof CoworkRewind>[0]> = {}) => ({
  points: [point()],
  onPlan: vi.fn(async () => ({
    ok: true as const,
    plan: { kind: 'restore' as const, sha: 'a'.repeat(40) },
  })),
  onRestore: vi.fn(async () => ({ ok: true as const })),
  ...over,
})

describe('going back to an earlier point', () => {
  it('shows nothing when there is nowhere to go back to', () => {
    render(<CoworkRewind {...props({ points: [] })} />)
    expect(screen.queryByTestId('cowork-rewind')).toBeNull()
  })

  it('never restores without a confirmation', async () => {
    const p = props()
    render(<CoworkRewind {...p} />)

    await userEvent.click(screen.getByText('common:rewind.goBack'))

    // Planning changed nothing; the restore waits for the second click.
    expect(p.onPlan).toHaveBeenCalledWith('a'.repeat(40))
    expect(p.onRestore).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('common:rewind.confirmRestore'))
    expect(p.onRestore).toHaveBeenCalledWith('a'.repeat(40))
  })

  it('offers a patch, and no restore at all, in the user’s own checkout', async () => {
    // The rule this component exists for: Jan does not own that tree, so
    // there is no button that overwrites it — not a disabled one, not one
    // behind a warning. There is the change, and that is the whole offer.
    const p = props({
      points: [point({ destination: 'user-checkout', root: '/home/dev/repo' })],
      onPlan: vi.fn(async () => ({
        ok: true as const,
        plan: { kind: 'patch' as const, diff: '--- a/x\n+++ b/x\n' },
      })),
    })
    render(<CoworkRewind {...p} />)

    await userEvent.click(screen.getByText('common:rewind.goBack'))

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'common:rewind.patchOnly'
    )
    expect(screen.getByRole('alertdialog')).toHaveTextContent('--- a/x')
    expect(screen.queryByText('common:rewind.confirmRestore')).toBeNull()
    expect(p.onRestore).not.toHaveBeenCalled()
  })

  it('leaves the tree alone when the confirmation is dismissed', async () => {
    const p = props()
    render(<CoworkRewind {...p} />)

    await userEvent.click(screen.getByText('common:rewind.goBack'))
    await userEvent.click(screen.getByText('common:rewind.cancel'))

    expect(p.onRestore).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('says why nothing happened when the plan cannot be made', async () => {
    const p = props({
      onPlan: vi.fn(async () => ({
        ok: false as const,
        reason: 'no such object',
      })),
    })
    render(<CoworkRewind {...p} />)

    await userEvent.click(screen.getByText('common:rewind.goBack'))

    expect(await screen.findByRole('alert')).toHaveTextContent('no such object')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
