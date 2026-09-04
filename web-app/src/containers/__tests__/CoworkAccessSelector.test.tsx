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

const SUPPORTED: CapabilityState = { known: true, directEdit: true }

const open = async (
  over: Partial<Parameters<typeof CoworkAccessSelector>[0]> = {}
) => {
  const onRequestDirectEdit = vi.fn()
  const onReviewOnly = vi.fn()
  render(
    <CoworkAccessSelector
      effective={reviewOnly}
      capability={SUPPORTED}
      hasFolder
      onRequestDirectEdit={onRequestDirectEdit}
      onReviewOnly={onReviewOnly}
      {...over}
    />
  )
  await user.click(screen.getByRole('button'))
  return { onRequestDirectEdit, onReviewOnly }
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
    await open({ capability: { known: true, directEdit: false } })
    const edit = await option('common:coworkAccess.edit-folder.label')

    expect(edit).toHaveAttribute('aria-disabled', 'true')
    expect(edit).toHaveTextContent('common:coworkAccess.unsupportedPlatform')
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
    const { onRequestDirectEdit } = await open({ busyReason: 'running' })
    const edit = await option('common:coworkAccess.edit-folder.label')

    expect(edit).toHaveTextContent('common:coworkAccess.busy.running')
    await user.click(edit)
    expect(onRequestDirectEdit).not.toHaveBeenCalled()
  })

  it('keeps the managed worktree visible but unavailable', async () => {
    await open()
    const worktree = await option('common:coworkAccess.managed-worktree.label')

    expect(worktree).toHaveAttribute('aria-disabled', 'true')
    expect(worktree).toHaveTextContent('common:coworkAccess.notBuiltYet')
  })
})

describe('choosing a mode', () => {
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
      busyReason: 'running',
    })

    await user.click(await option('common:coworkAccess.review-only.label'))

    expect(onReviewOnly).not.toHaveBeenCalled()
  })
})
