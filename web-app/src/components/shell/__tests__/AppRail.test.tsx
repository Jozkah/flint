import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RAIL_ITEMS } from '@/lib/shellNavigation'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: '/' }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  // Echo a human-ish label so we assert on the visible text, not on a key.
  useTranslation: () => ({ t: (key: string) => key.split('.').pop() ?? key }),
}))

vi.mock('@/hooks/useSearchDialog', () => ({
  useSearchDialog: { getState: () => ({ setOpen: vi.fn() }) },
}))

vi.mock('@/hooks/useCoworkRun', () => ({
  useCoworkRun: (sel: (s: { runs: Record<string, unknown> }) => unknown) => sel({ runs: {} }),
}))

import { AppRail } from '../AppRail'

describe('AppRail overflow safety', () => {
  it('renders every rail item as a self-contained tile', () => {
    render(<AppRail />)
    for (const item of RAIL_ITEMS) {
      expect(screen.getByTestId(item.id === 'settings' ? 'cowork-settings' : `rail-${item.id}`)).toBeInTheDocument()
    }
  })

  it('bounds each label to the tile and never clips it — no truncation, whole words kept', () => {
    const { container } = render(<AppRail />)
    // The label is the last span inside each tile; assert the layout contract
    // on every one so a long or localized label fits the 64px rail without
    // spilling past its edge, keeps whole words (no mid-word break like
    // "Workspa ce"), and is never hidden by truncation.
    const tiles = container.querySelectorAll('[data-testid^="rail-"], [data-testid="cowork-settings"]')
    expect(tiles.length).toBe(RAIL_ITEMS.length)
    for (const tile of Array.from(tiles)) {
      const label = tile.querySelector('span')
      expect(label).not.toBeNull()
      const cls = label!.className
      expect(cls).toContain('w-full')
      expect(cls).toContain('text-center')
      // Words stay whole and the label shrinks to fit rather than breaking a
      // word across two lines; multi-word labels still wrap between words.
      expect(cls).toContain('[word-break:keep-all]')
      expect(cls).toContain('[overflow-wrap:normal]')
      expect(cls).not.toContain('truncate')
      expect(cls).not.toContain('whitespace-nowrap')
      // Tile grows with wrapped text rather than clipping at a fixed height.
      expect(tile.className).toContain('min-h-[52px]')
      expect(tile.className).not.toMatch(/(^|\s)h-\[52px\]/)
    }
  })

  it('clips the rail horizontally so nothing can spill sideways out of it', () => {
    render(<AppRail />)
    const rail = screen.getByTestId('app-rail')
    expect(rail.className).toContain('overflow-x-hidden')
    expect(rail.className).toContain('w-(--rail-w)')
  })
})
