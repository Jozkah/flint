import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { FadeText } from '@/components/ui/fade-text'
import { NavButton, NavItem } from '@/components/shell/nav-kit'

// jsdom does no layout: stub the two widths the hook compares.
function stubWidths(scroll: number, client: number) {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scroll)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(client)
}

afterEach(() => vi.restoreAllMocks())

describe('text fades only when it overflows', () => {
  it('a short label has no overflow mark, so no fade', () => {
    stubWidths(60, 120)
    render(<FadeText>New room</FadeText>)
    const el = screen.getByText('New room')
    expect(el).toHaveClass('text-fade')
    expect(el).not.toHaveAttribute('data-overflow')
  })

  it('a label wider than its box is marked and fades', () => {
    stubWidths(300, 120)
    render(<FadeText>A very long session title that runs on</FadeText>)
    expect(
      screen.getByText('A very long session title that runs on')
    ).toHaveAttribute('data-overflow', 'true')
  })

  it('keeps its tag and extra classes', () => {
    stubWidths(10, 100)
    render(
      <FadeText as="h2" className="font-medium">
        Title
      </FadeText>
    )
    const el = screen.getByText('Title')
    expect(el.tagName).toBe('H2')
    expect(el.className).toBe('text-fade font-medium')
  })

  it("a nav row marks its label only when it overflows", () => {
    stubWidths(60, 120)
    const { unmount } = render(
      <ul>
        <NavItem>
          <NavButton>
            <span>New session</span>
          </NavButton>
        </NavItem>
      </ul>
    )
    expect(screen.getByText('New session')).not.toHaveAttribute('data-overflow')
    unmount()
    vi.restoreAllMocks()
    stubWidths(400, 120)
    render(
      <ul>
        <NavItem>
          <NavButton>
            <span>A session title far too long for the sidebar</span>
          </NavButton>
        </NavItem>
      </ul>
    )
    expect(
      screen.getByText('A session title far too long for the sidebar')
    ).toHaveAttribute('data-overflow', 'true')
  })
})
