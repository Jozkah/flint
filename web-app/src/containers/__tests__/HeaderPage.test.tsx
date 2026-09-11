import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import HeaderPage from '../HeaderPage'
import type { WindowChrome } from '@/lib/titlebar'

/**
 * Who drags the window depends on who draws its title bar.
 *
 * With native chrome (Windows) the operating system draws a real title bar and
 * owns dragging, double-click maximise and Snap Layouts. The header must then
 * declare no drag region at all: one would only turn presses on the page into
 * window moves, which is the fragile behaviour the native bar replaced.
 *
 * Where the app draws its own chrome (the macOS overlay, the borderless Linux
 * window) the header is the drag handle. Tauri drags only when the element
 * actually pressed carries `data-tauri-drag-region`, so every element that
 * spans the bar and holds no control of its own has to carry it, or the bar has
 * dead space again.
 */

let chrome: WindowChrome = 'native'
let layout = { left: [] as string[], right: [] as string[] }

vi.mock('@/hooks/useLeftPanel', () => ({
  useLeftPanel: () => ({ open: false, setLeftPanel: vi.fn() }),
}))

vi.mock('@/stores/titlebar-layout-store', () => ({
  useTitlebarLayout: (select: (s: unknown) => unknown) => select({ layout }),
}))

vi.mock('@/lib/titlebar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/titlebar')>()
  return {
    ...actual,
    detectMacOverlay: () => chrome === 'mac-overlay',
    detectWindowChrome: () => chrome,
  }
})

beforeEach(() => {
  chrome = 'native'
  layout = { left: [], right: [] }
})

describe('HeaderPage with a native title bar', () => {
  it('declares no drag region anywhere in the header', () => {
    const { container } = render(
      <HeaderPage>
        <span>page title</span>
      </HeaderPage>
    )
    const outer = container.firstElementChild as HTMLElement
    expect(outer.hasAttribute('data-tauri-drag-region')).toBe(false)
    expect(outer.querySelectorAll('[data-tauri-drag-region]')).toHaveLength(0)
    expect(outer.className).not.toContain('cursor-grab')
  })

  it('reserves no room for app-drawn window buttons', () => {
    // The layout store still carries its min/max/close default; with a native
    // title bar none of those are drawn by the app.
    layout = { left: [], right: ['minimize', 'maximize', 'close'] }
    const { container } = render(<HeaderPage />)
    const outer = container.firstElementChild as HTMLElement
    expect(outer.style.paddingRight).toBe('')
    expect(outer.style.paddingLeft).toBe('')
  })

  it('keeps the sidebar toggle a plain button', () => {
    render(<HeaderPage />)
    const toggle = screen.getByLabelText('Toggle sidebar')
    expect(toggle.closest('[data-tauri-drag-region]')).toBeNull()
  })
})

describe.each<WindowChrome>(['custom', 'mac-overlay'])(
  'HeaderPage drag region with %s chrome',
  (kind) => {
    beforeEach(() => {
      chrome = kind
    })

    it('makes the full-width row draggable, not just the padding', () => {
      const { container } = render(<HeaderPage />)

      const outer = container.firstElementChild as HTMLElement
      expect(outer).toBeTruthy()
      expect(outer.hasAttribute('data-tauri-drag-region')).toBe(true)

      // The row that spans the header. Without the attribute it covers the
      // whole bar and swallows every press.
      const row = outer.querySelector(':scope > div') as HTMLElement
      expect(row).toBeTruthy()
      expect(row.className).toContain('w-full')
      expect(row.hasAttribute('data-tauri-drag-region')).toBe(true)
    })

    it('makes the stretch that fills the bar draggable', () => {
      const { container } = render(<HeaderPage />)
      const stretch = container.querySelector('.flex-1') as HTMLElement
      expect(stretch).toBeTruthy()
      expect(stretch.hasAttribute('data-tauri-drag-region')).toBe(true)
    })

    /**
     * Controls must stay clickable. An element that is itself a drag region
     * cannot be pressed for its own sake, so the sidebar toggle must NOT carry
     * the attribute.
     */
    it('leaves controls clickable rather than draggable', () => {
      render(<HeaderPage />)
      const toggle = screen.getByLabelText('Toggle sidebar')
      expect(toggle.hasAttribute('data-tauri-drag-region')).toBe(false)
      expect(toggle.closest('[data-tauri-drag-region]')).not.toBe(toggle)
    })
  }
)

describe('HeaderPage with app-drawn Linux buttons', () => {
  it('reserves exactly the room the drawn buttons take', () => {
    chrome = 'custom'
    layout = { left: [], right: ['minimize', 'maximize', 'close'] }
    const { container } = render(<HeaderPage />)
    const outer = container.firstElementChild as HTMLElement
    expect(outer.style.paddingRight).toBe(`${3 * 32 + 24}px`)
  })
})
