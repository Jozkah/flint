import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useSpotlight } from '../useSpotlight'
import { useInterfaceSettings } from '../useInterfaceSettings'

function Card() {
  const { onPointerMove, className } = useSpotlight()
  return (
    <div
      data-testid="card"
      className={className}
      onPointerMove={onPointerMove}
    />
  )
}

// jsdom has no PointerEvent: a MouseEvent that also carries pointerType.
class TestPointerEvent extends MouseEvent {
  pointerType: string
  constructor(
    type: string,
    init: MouseEventInit & { pointerType?: string } = {}
  ) {
    super(type, init)
    this.pointerType = init.pointerType ?? 'mouse'
  }
}
Object.defineProperty(window, 'PointerEvent', {
  value: TestPointerEvent,
  configurable: true,
})

describe('useSpotlight', () => {
  beforeEach(() => useInterfaceSettings.setState({ reduceMotion: false }))

  it('sets the cursor variables relative to the card', () => {
    render(<Card />)
    const card = screen.getByTestId('card')
    card.getBoundingClientRect = () => ({
      left: 10,
      top: 20,
      width: 100,
      height: 50,
      right: 110,
      bottom: 70,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    })
    expect(card).toHaveClass('spot-card')
    fireEvent.pointerMove(card, {
      clientX: 40,
      clientY: 50,
      pointerType: 'mouse',
    })
    expect(card.style.getPropertyValue('--mx')).toBe('30px')
    expect(card.style.getPropertyValue('--my')).toBe('30px')
  })

  it('ignores touch', () => {
    render(<Card />)
    const card = screen.getByTestId('card')
    fireEvent.pointerMove(card, {
      clientX: 40,
      clientY: 50,
      pointerType: 'touch',
    })
    expect(card.style.getPropertyValue('--mx')).toBe('')
  })

  it('is off when motion is reduced', () => {
    useInterfaceSettings.setState({ reduceMotion: true })
    render(<Card />)
    const card = screen.getByTestId('card')
    expect(card).not.toHaveClass('spot-card')
    fireEvent.pointerMove(card, {
      clientX: 40,
      clientY: 50,
      pointerType: 'mouse',
    })
    expect(card.style.getPropertyValue('--mx')).toBe('')
  })
})
