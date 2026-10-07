import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { Slider } from '../slider'

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    width: 200,
    height: 20,
    top: 0,
    left: 0,
    bottom: 20,
    right: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }))
})

const bubbles = () =>
  Array.from(document.querySelectorAll('[data-slot="slider-bubble"]'))

describe('Slider value bubble', () => {
  it('shows the current value above each thumb', () => {
    render(<Slider value={[25, 75]} />)
    expect(bubbles().map((b) => b.textContent)).toEqual(['25', '75'])
  })

  it('uses formatValue', () => {
    render(<Slider value={[7]} min={0} max={10} formatValue={(v) => `${v}%`} />)
    expect(bubbles()[0].textContent).toBe('7%')
  })

  it('follows keyboard changes when uncontrolled and keeps aria', () => {
    const onChange = vi.fn()
    render(<Slider defaultValue={[10]} onValueChange={onChange} />)
    const thumb = document.querySelector('[role="slider"]') as HTMLElement
    expect(thumb).toHaveAttribute('aria-valuenow', '10')
    fireEvent.keyDown(thumb, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith([11])
    expect(bubbles()[0].textContent).toBe('11')
    expect(thumb).toHaveAttribute('aria-valuenow', '11')
  })

  it('marks the root hot on mouse hover', () => {
    render(<Slider value={[50]} />)
    const root = document.querySelector('[data-slot="slider"]') as HTMLElement
    expect(root).not.toHaveAttribute('data-hot')
    fireEvent.pointerEnter(root, { pointerType: 'mouse' })
    expect(root).toHaveAttribute('data-hot')
    fireEvent.pointerLeave(root, { pointerType: 'mouse' })
    expect(root).not.toHaveAttribute('data-hot')
  })

  it('has no bubble when vertical', () => {
    render(<Slider value={[50]} orientation="vertical" />)
    expect(bubbles()).toHaveLength(0)
  })
})
