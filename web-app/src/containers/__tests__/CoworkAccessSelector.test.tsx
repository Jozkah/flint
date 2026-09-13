import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { CoworkAccessSelector } from '../CoworkAccessSelector'
import type { EffectiveAccess } from '@/lib/coworkAccess'
import type { CapabilityState } from '@/hooks/useDirectEditGrants'

const user = userEvent.setup({ pointerEventsCheck: 0 })

const reviewOnly: EffectiveAccess = {
  access: 'review-only',
  readRoot: '/home/dev/obs-forwarder',
  writeRoot: null,
  destination: 'sandbox',
}

const editing: EffectiveAccess = {
  access: 'edit-folder',
  readRoot: '/home/dev/obs-forwarder',
  writeRoot: '/home/dev/obs-forwarder',
  destination: 'repository',
}

const SUPPORTED: CapabilityState = {
  known: true,
  directEdit: true,
  managedWorktree: true,
}

/** Windows: a Jan-owned worktree can be confined, the user's folder cannot. */
const WINDOWS: CapabilityState = {
  known: true,
  directEdit: false,
  managedWorktree: true,
}

const open = async (
  over: Partial<Parameters<typeof CoworkAccessSelector>[0]> = {}
) => {
  const onRequestDirectEdit = vi.fn()
  const onRequestWorktree = vi.fn()
  const onReviewOnly = vi.fn()
  render(
    <CoworkAccessSelector
      effective={reviewOnly}
      capability={SUPPORTED}
      hasFolder
      onRequestDirectEdit={onRequestDirectEdit}
      onRequestWorktree={onRequestWorktree}
      onReviewOnly={onReviewOnly}
      {...over}
    />
  )
  await user.click(screen.getByRole('button'))
  return { onRequestDirectEdit, onRequestWorktree, onReviewOnly }
}

const option = async (name: string) =>
  (await screen.findAllByRole('menuitemradio')).find((el) =>
    el.textContent?.includes(name)
  )!

describe('what the selector reports', () => {
  // The stored preference is not the subject. What would actually happen is.
  it('names the access in force, not the one last preferred', () => {
    render(
      <CoworkAccessSelector
        effective={{
          ...reviewOnly,
          downgradedFrom: 'edit-folder',
          reason: 'no-grant',
        }}
        capability={SUPPORTED}
        hasFolder
        onRequestDirectEdit={vi.fn()}
        onReviewOnly={vi.fn()}
      />
    )

    expect(screen.getByRole('button')).toHaveTextContent(
      'common:coworkAccess.review-only.label'
    )
  })

  it('announces why the stored preference is not in force', () => {
    const { container } = render(
      <CoworkAccessSelector
        effective={{
          ...reviewOnly,
          downgradedFrom: 'edit-folder',
          reason: 'no-grant',
        }}
        capability={SUPPORTED}
        hasFolder
        onRequestDirectEdit={vi.fn()}
        onReviewOnly={vi.fn()}
      />
    )

    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(
      'common:coworkAccess.downgrade.no-grant'
    )
  })

  it('marks the mode in force as the selected one', async () => {
    await open({ effective: editing })
    const options = await screen.findAllByRole('menuitemradio')

    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ])
  })
})

describe('when editing a folder cannot be offered', () => {
  it('is disabled with no folder attached', async () => {
    const { onRequestDirectEdit } = await open({ hasFolder: false })
    const edit = await option('common:coworkAccess.edit-folder.label')

    expect(edit).toHaveAttribute('aria-disabled', 'true')
    expect(edit).toHaveTextContent('common:coworkAccess.needsFolder')
    await user.click(edit)
    expect(onRequestDirectEdit).not.toHaveBeenCalled()
  })

  // Windows, or a machine with no sandbox: the option is never offered rather
  // than failing after the user commits to it.
  it('is disabled where the platform cannot enforce it', async () => {
    await open({ capability: { known: true, directEdit: false, managedWorktree: false } })
    const edit = await option('common:coworkAccess.edit-folder.label')

    expect(edit).toHaveAttribute('aria-disabled', 'true')
    expect(edit).toHaveTextContent('common:coworkAccess.unsupportedPlatform')
  })

  /// The regression. Both modes used to ask one question, so Windows -- where
  /// only direct editing is impossible -- could not offer Managed worktree
  /// either, and the proposal review behind it was unreachable.
  it('offers Managed worktree where only Jan-owned folders can be confined', async () => {
    const { onRequestWorktree, onRequestDirectEdit } = await open({
      capability: WINDOWS,
    })
    const edit = await option('common:coworkAccess.edit-folder.label')
    const worktree = await option('common:coworkAccess.managed-worktree.label')

    expect(edit).toHaveAttribute('aria-disabled', 'true')
    expect(worktree).not.toHaveAttribute('aria-disabled', 'true')
    await user.click(worktree)
    expect(onRequestWorktree).toHaveBeenCalled()
    expect(onRequestDirectEdit).not.toHaveBeenCalled()
  })

  it.each([
    ['loading', { known: false, reason: 'loading' } as CapabilityState],
    [
      'failed',
      { known: false, reason: 'failed', message: 'x' } as CapabilityState,
    ],
  ])('is disabled while the capability is %s', async (_name, capability) => {
    await open({ capability })
    const edit = await option('common:coworkAccess.edit-folder.label')

    expect(edit).toHaveAttribute('aria-disabled', 'true')
  })

  // Authority must not move under work that is already running.
  it('is disabled while a run is in flight, and says so', async () => {
    const { onRequestDirectEdit } = await open({ busyReason: 'run' })
    const edit = await option('common:coworkAccess.edit-folder.label')

    expect(edit).toHaveTextContent('common:coworkAccess.busy.run')
    await user.click(edit)
    expect(onRequestDirectEdit).not.toHaveBeenCalled()
  })

  // A background shell job outlives the run that started it and can still
  // write, so it holds authority in place just as a live turn does.
  it('is disabled while a background job is still running', async () => {
    const { onRequestDirectEdit } = await open({ busyReason: 'job' })
    const edit = await option('common:coworkAccess.edit-folder.label')

    expect(edit).toHaveTextContent('common:coworkAccess.busy.job')
    await user.click(edit)
    expect(onRequestDirectEdit).not.toHaveBeenCalled()
  })

  // A subagent or a foreground shell writes under the same authority the run
  // does, so each holds it in place on its own.
  it.each(['subagent', 'shell'] as const)(
    'is disabled while a %s is writing',
    async (busyReason) => {
      const { onRequestDirectEdit } = await open({ busyReason })
      const edit = await option('common:coworkAccess.edit-folder.label')

      expect(edit).toHaveTextContent(`common:coworkAccess.busy.${busyReason}`)
      await user.click(edit)
      expect(onRequestDirectEdit).not.toHaveBeenCalled()
    }
  )

  it.each(['authorizing', 'revoking'] as const)(
    'is disabled while %s is in flight',
    async (busyReason) => {
      await open({ busyReason })
      const edit = await option('common:coworkAccess.edit-folder.label')

      expect(edit).toHaveTextContent(`common:coworkAccess.busy.${busyReason}`)
    }
  )

  it('offers the managed worktree once writes can be confined', async () => {
    // It was inert while there was no lifecycle beneath it. There is one now,
    // and it rests on the same confinement direct editing does.
    await open()
    const worktree = await option('common:coworkAccess.managed-worktree.label')

    expect(worktree).toHaveAttribute('aria-disabled', 'false')
  })

  it('withholds the worktree on a platform that cannot confine writes', async () => {
    // A worktree the shell could escape is not isolation, so the option is not
    // offered rather than offered and quietly downgraded.
    await open({ capability: { known: true, directEdit: false, managedWorktree: false } })
    const worktree = await option('common:coworkAccess.managed-worktree.label')

    expect(worktree).toHaveAttribute('aria-disabled', 'true')
    expect(worktree).toHaveTextContent(
      'common:coworkAccess.unsupportedPlatform'
    )
  })
})

describe('choosing a mode', () => {
  it('asks for a worktree without a separate confirmation', async () => {
    // Unlike direct editing, this cannot alter the user's checkout, so there
    // is nothing to warn about that the mode's own description does not say.
    const { onRequestWorktree, onRequestDirectEdit } = await open()
    const worktree = await option('common:coworkAccess.managed-worktree.label')
    worktree.click()

    expect(onRequestWorktree).toHaveBeenCalled()
    expect(onRequestDirectEdit).not.toHaveBeenCalled()
  })

  // Selecting is not confirming: the switch happens after a grant exists.
  it('asks for confirmation rather than switching', async () => {
    const { onRequestDirectEdit } = await open()

    await user.click(await option('common:coworkAccess.edit-folder.label'))

    expect(onRequestDirectEdit).toHaveBeenCalledTimes(1)
  })

  it('hands review only to the caller, which revokes before downgrading', async () => {
    const { onReviewOnly } = await open({ effective: editing })

    await user.click(await option('common:coworkAccess.review-only.label'))

    expect(onReviewOnly).toHaveBeenCalledTimes(1)
  })

  it('does not switch away while a run is in flight', async () => {
    const { onReviewOnly } = await open({
      effective: editing,
      busyReason: 'run',
    })

    await user.click(await option('common:coworkAccess.review-only.label'))

    expect(onReviewOnly).not.toHaveBeenCalled()
  })
})
