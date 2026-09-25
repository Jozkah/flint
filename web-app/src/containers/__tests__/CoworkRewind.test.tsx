import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k}#${Object.values(opts).join(',')}` : k,
  }),
}))

import { CoworkRewind } from '../CoworkRewind'
import type { CheckpointEntry, RewindPlan } from '@/hooks/useCoworkCheckpoints'

const point = (over: Partial<CheckpointEntry> = {}): CheckpointEntry => ({
  sha: 'a'.repeat(40),
  label: 'rename the parser',
  destination: 'managed',
  root: '/data/worktrees/s1',
  at: 1,
  access: 'managed-worktree',
  ...over,
})

const restorePlan = (
  over: Partial<Extract<RewindPlan, { kind: 'restore' }>> = {}
) => ({
  ok: true as const,
  plan: {
    kind: 'restore' as const,
    sha: 'a'.repeat(40),
    files: ['src/parser.ts'],
    changedSinceLatest: [],
    ...over,
  },
})

const props = (over: Partial<Parameters<typeof CoworkRewind>[0]> = {}) => ({
  points: [point()],
  onPlan: vi.fn(async () => restorePlan()),
  onSafetyCapture: vi.fn(async (label: string) => ({
    ok: true as const,
    point: point({ sha: 'f'.repeat(40), label, safety: true }),
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
    expect(p.onSafetyCapture).not.toHaveBeenCalled()
    expect(p.onRestore).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('common:rewind.confirmRestore'))
    await waitFor(() =>
      expect(p.onRestore).toHaveBeenCalledWith('a'.repeat(40))
    )
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
    expect(p.onSafetyCapture).not.toHaveBeenCalled()
  })

  it('leaves the tree alone when the confirmation is dismissed', async () => {
    const p = props()
    render(<CoworkRewind {...p} />)

    await userEvent.click(screen.getByText('common:rewind.goBack'))
    await userEvent.click(screen.getByText('common:rewind.cancel'))

    expect(p.onRestore).not.toHaveBeenCalled()
    expect(p.onSafetyCapture).not.toHaveBeenCalled()
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

describe('the scope and boundaries of a restore', () => {
  it('names the tree, the files, and what a restore cannot undo', async () => {
    render(<CoworkRewind {...props()} />)
    await userEvent.click(screen.getByText('common:rewind.goBack'))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(
      'results:rewind.scopeTree#/data/worktrees/s1'
    )
    expect(dialog).toHaveTextContent('results:rewind.filesHeading#1')
    expect(dialog).toHaveTextContent('src/parser.ts')
    expect(dialog).toHaveTextContent('results:rewind.safetyNote')
    expect(dialog).toHaveTextContent('results:rewind.boundaries')
    // The boundaries are what the dialog is described by, so a screen reader
    // announces them with the question.
    expect(dialog).toHaveAccessibleDescription('results:rewind.boundaries')
  })

  it('says when there is nothing to put back, or when the files are unknown', async () => {
    const { unmount } = render(
      <CoworkRewind
        {...props({ onPlan: vi.fn(async () => restorePlan({ files: [] })) })}
      />
    )
    await userEvent.click(screen.getByText('common:rewind.goBack'))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'results:rewind.noFiles'
    )
    unmount()

    render(
      <CoworkRewind
        {...props({
          onPlan: vi.fn(async () => ({
            ok: true as const,
            plan: { kind: 'restore' as const, sha: 'a'.repeat(40) },
          })),
        })}
      />
    )
    await userEvent.click(screen.getByText('common:rewind.goBack'))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'results:rewind.filesUnknown'
    )
  })

  it('moves focus into the confirmation and back to its trigger', async () => {
    render(<CoworkRewind {...props()} />)
    const trigger = screen.getByText('common:rewind.goBack')

    await userEvent.click(trigger)
    const dialog = await screen.findByRole('alertdialog')
    await waitFor(() => expect(dialog).toHaveFocus())

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })
})

describe('a safety point before every restore', () => {
  it('saves the current state first, then restores', async () => {
    const order: string[] = []
    const p = props({
      onSafetyCapture: vi.fn(async (label: string) => {
        order.push('capture')
        return {
          ok: true as const,
          point: point({ sha: 'f'.repeat(40), label, safety: true }),
        }
      }),
      onRestore: vi.fn(async () => {
        order.push('restore')
        return { ok: true as const }
      }),
    })
    render(<CoworkRewind {...p} />)

    await userEvent.click(screen.getByText('common:rewind.goBack'))
    await userEvent.click(screen.getByText('common:rewind.confirmRestore'))

    await waitFor(() => expect(order).toEqual(['capture', 'restore']))
    expect(p.onSafetyCapture).toHaveBeenCalledWith(
      expect.stringContaining('results:rewind.safetyLabel#')
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      'results:rewind.restored#results:rewind.safetyLabel#'
    )
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('does not restore when the current state could not be saved', async () => {
    const p = props({
      onSafetyCapture: vi.fn(async () => ({
        ok: false as const,
        reason: 'disk full',
      })),
    })
    render(<CoworkRewind {...p} />)

    await userEvent.click(screen.getByText('common:rewind.goBack'))
    await userEvent.click(screen.getByText('common:rewind.confirmRestore'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'results:rewind.safetyFailed#disk full'
    )
    expect(p.onRestore).not.toHaveBeenCalled()
    // Still open, with the same scope in front of the person.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('reports a refused restore after the state was saved', async () => {
    const p = props({
      onRestore: vi.fn(async () => ({
        ok: false as const,
        reason: 'worktree is gone',
      })),
    })
    render(<CoworkRewind {...p} />)

    await userEvent.click(screen.getByText('common:rewind.goBack'))
    await userEvent.click(screen.getByText('common:rewind.confirmRestore'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'worktree is gone'
    )
    expect(p.onSafetyCapture).toHaveBeenCalledTimes(1)
  })

  it('requires an explicit acknowledgement to overwrite edits Jan did not make', async () => {
    const p = props({
      onPlan: vi.fn(async () =>
        restorePlan({
          files: ['src/parser.ts', 'notes.md'],
          changedSinceLatest: ['src/parser.ts', 'notes.md'],
        })
      ),
      janAuthored: ['src/parser.ts'],
    })
    render(<CoworkRewind {...p} />)

    await userEvent.click(screen.getByText('common:rewind.goBack'))

    const warning = await screen.findByTestId('cowork-rewind-unrelated')
    // Jan's own write is not someone else's edit; the note is.
    expect(warning).toHaveTextContent('notes.md')
    expect(warning).not.toHaveTextContent('src/parser.ts')

    const confirm = screen.getByRole('button', {
      name: 'common:rewind.confirmRestore',
    })
    expect(confirm).toBeDisabled()
    await userEvent.click(confirm)
    expect(p.onSafetyCapture).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByRole('checkbox', { name: 'results:rewind.unrelatedConfirm' })
    )
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)
    await waitFor(() => expect(p.onRestore).toHaveBeenCalled())
  })

  it('asks for nothing extra when every newer edit is Jan’s', async () => {
    render(
      <CoworkRewind
        {...props({
          onPlan: vi.fn(async () =>
            restorePlan({ changedSinceLatest: ['/data/worktrees/s1/src/parser.ts'] })
          ),
          janAuthored: ['src/parser.ts'],
        })}
      />
    )
    await userEvent.click(screen.getByText('common:rewind.goBack'))
    await screen.findByRole('alertdialog')
    expect(screen.queryByTestId('cowork-rewind-unrelated')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'common:rewind.confirmRestore' })
    ).toBeEnabled()
  })

  it('previews the restore diff before confirming, without restoring', async () => {
    const onPreviewDiff = vi.fn(async () => ({
      ok: true as const,
      diff: 'diff --git a/src/parser.ts b/src/parser.ts\n-new line\n+old line',
    }))
    const p = props({ onPreviewDiff })
    render(<CoworkRewind {...p} />)
    await userEvent.click(screen.getByText('common:rewind.goBack'))
    await userEvent.click(screen.getByText('results:rewind.previewDiff'))

    const diff = await screen.findByTestId('cowork-rewind-diff')
    expect(onPreviewDiff).toHaveBeenCalledWith('a'.repeat(40))
    expect(diff).toHaveTextContent('-new line')
    expect(diff).toHaveTextContent('+old line')
    expect(p.onRestore).not.toHaveBeenCalled()
    // The files list is still there alongside the diff.
    expect(screen.getByText('src/parser.ts')).toBeInTheDocument()

    await userEvent.click(screen.getByText('results:rewind.hideDiff'))
    expect(screen.queryByTestId('cowork-rewind-diff')).toBeNull()
  })

  it('reports a diff that could not be built', async () => {
    const p = props({
      onPreviewDiff: vi.fn(async () => ({ ok: false as const, reason: 'git broke' })),
    })
    render(<CoworkRewind {...p} />)
    await userEvent.click(screen.getByText('common:rewind.goBack'))
    await userEvent.click(screen.getByText('results:rewind.previewDiff'))
    expect(
      await screen.findByText('results:rewind.previewFailed#git broke')
    ).toBeInTheDocument()
  })

  it('offers no preview without a diff source', async () => {
    render(<CoworkRewind {...props()} />)
    await userEvent.click(screen.getByText('common:rewind.goBack'))
    expect(screen.queryByText('results:rewind.previewDiff')).toBeNull()
  })
})
