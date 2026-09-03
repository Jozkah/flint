import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { CoworkRailToolbar } from '../CoworkRailToolbar'
import type { ActivityProgress } from '@/lib/coworkActivity'

const noActivity: ActivityProgress = { running: 0, queued: 0, finished: 0 }

function setup(over: Partial<Parameters<typeof CoworkRailToolbar>[0]> = {}) {
  const onSelect = vi.fn()
  render(
    <CoworkRailToolbar
      active={null}
      onSelect={onSelect}
      changeCount={0}
      additions={0}
      deletions={0}
      activity={noActivity}
      {...over}
    />
  )
  return { onSelect }
}

describe('CoworkRailToolbar', () => {
  // The whole point of the toolbar: all four rails are discoverable at all
  // times, even with nothing to show — not hidden behind a transient event.
  it('always shows all four modes even when everything is empty', () => {
    setup()
    for (const label of [
      'common:rail.code',
      'common:rail.preview',
      'common:rail.changes',
      'common:rail.activity',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('marks the active mode as pressed and leaves the others unpressed', () => {
    setup({ active: 'changes' })
    expect(
      screen.getByRole('button', { name: 'common:rail.changes' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('button', { name: 'common:rail.code' })
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('reports the selected mode', async () => {
    const { onSelect } = setup()
    await userEvent.click(
      screen.getByRole('button', { name: 'common:rail.preview' })
    )
    expect(onSelect).toHaveBeenCalledWith('preview')
  })

  it('shows combined change counts only when there are changes', () => {
    const { unmount } = render(
      <CoworkRailToolbar
        active={null}
        onSelect={vi.fn()}
        changeCount={0}
        additions={0}
        deletions={0}
        activity={noActivity}
      />
    )
    expect(screen.queryByText('+0')).toBeNull()
    unmount()
    render(
      <CoworkRailToolbar
        active={null}
        onSelect={vi.fn()}
        changeCount={2}
        additions={5}
        deletions={3}
        activity={noActivity}
      />
    )
    expect(screen.getByText('+5')).toBeInTheDocument()
    expect(screen.getByText('-3')).toBeInTheDocument()
  })

  it('shows the in-flight activity count while work runs', () => {
    setup({ activity: { running: 2, queued: 1, finished: 4 } })
    // running + queued takes precedence over finished while work is live.
    expect(screen.getByText('3')).toBeInTheDocument()
  })
})
