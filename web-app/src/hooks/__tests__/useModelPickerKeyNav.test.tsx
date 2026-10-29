import { describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { useModelPickerKeyNav } from '../useModelPickerKeyNav'

function Picker({ onPick }: { onPick: (id: string) => void }) {
  const pickerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const onKeyDown = useModelPickerKeyNav(pickerRef, inputRef)
  return (
    <div ref={pickerRef} onKeyDown={onKeyDown}>
      <input ref={inputRef} aria-label="search" />
      {['a', 'b', 'c'].map((id) => (
        <div
          key={id}
          data-model-row=""
          tabIndex={0}
          role="button"
          onClick={() => onPick(id)}
        >
          {id}
        </div>
      ))}
    </div>
  )
}

describe('useModelPickerKeyNav', () => {
  const setup = () => {
    const onPick = vi.fn()
    render(<Picker onPick={onPick} />)
    return { onPick, input: screen.getByLabelText('search') }
  }

  it('ArrowDown from the input focuses the first row, then moves and clamps', () => {
    const { input } = setup()
    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByText('a'))
    fireEvent.keyDown(screen.getByText('a'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByText('b'))
    fireEvent.keyDown(screen.getByText('c'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByText('c'))
  })

  it('ArrowUp on the first row returns to the input', () => {
    const { input } = setup()
    fireEvent.keyDown(screen.getByText('a'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(screen.getByText('c'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByText('b'))
  })

  it('Home and End jump to the ends', () => {
    setup()
    fireEvent.keyDown(screen.getByText('b'), { key: 'End' })
    expect(document.activeElement).toBe(screen.getByText('c'))
    fireEvent.keyDown(screen.getByText('c'), { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByText('a'))
  })

  it('Enter in the input picks the first row', () => {
    const { input, onPick } = setup()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('a')
  })

  it('typing on a row goes back to the input; modifiers and space do not', () => {
    const { input } = setup()
    const b = screen.getByText('b')
    b.focus()
    fireEvent.keyDown(b, { key: ' ' })
    fireEvent.keyDown(b, { key: 'x', ctrlKey: true })
    expect(document.activeElement).toBe(b)
    fireEvent.keyDown(b, { key: 'x' })
    expect(document.activeElement).toBe(input)
  })

  it('ignores keys while composing', () => {
    const { input } = setup()
    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true })
    expect(document.activeElement).toBe(input)
  })
})
