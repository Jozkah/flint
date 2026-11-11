import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { ShortcutRebind } from '../ShortcutRebind'
import { ShortcutAction } from '@/lib/shortcuts'

describe('ShortcutRebind', () => {
  it('names each Change button after its action', () => {
    const label = (a: ShortcutAction) => (a === ShortcutAction.NEW_CHAT ? 'New chat' : 'Search')
    render(
      <>
        <ShortcutRebind action={ShortcutAction.NEW_CHAT} label={label}>
          <span>keys</span>
        </ShortcutRebind>
        <ShortcutRebind action={ShortcutAction.SEARCH} label={label}>
          <span>keys</span>
        </ShortcutRebind>
      </>
    )
    expect(screen.getByRole('button', { name: 'settings:shortcuts.change: New chat' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'settings:shortcuts.change: Search' })).toBeInTheDocument()
  })
})
