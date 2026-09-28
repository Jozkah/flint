import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useOverflowCollapse } from '@/hooks/useOverflowCollapse'

// jsdom has no layout: the row's sizes are set by hand.
function size(el: HTMLElement, client: number, scroll: number) {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: client })
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scroll })
}

let row: HTMLDivElement | null = null
function Row({ tick }: { tick: number }) {
  const { ref, collapsed } = useOverflowCollapse<HTMLDivElement>()
  return (
    <div
      data-tick={tick}
      data-testid="row"
      data-collapsed={collapsed ? 'yes' : 'no'}
      ref={(el) => {
        ref(el)
        row = el
      }}
    />
  )
}

describe('useOverflowCollapse', () => {
  it('collapses when the content overflows, and comes back only with room to spare', () => {
    const { rerender } = render(<Row tick={0} />)
    expect(screen.getByTestId('row').dataset.collapsed).toBe('no')

    size(row!, 200, 340)
    rerender(<Row tick={1} />)
    expect(screen.getByTestId('row').dataset.collapsed).toBe('yes')

    // Collapsed, the row no longer overflows; that alone does not bring the
    // content back, or it would flicker.
    size(row!, 300, 300)
    rerender(<Row tick={2} />)
    expect(screen.getByTestId('row').dataset.collapsed).toBe('yes')

    size(row!, 350, 350)
    rerender(<Row tick={3} />)
    expect(screen.getByTestId('row').dataset.collapsed).toBe('no')
  })
})
