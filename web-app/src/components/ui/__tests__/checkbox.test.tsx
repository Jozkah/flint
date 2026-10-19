import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Checkbox } from '../checkbox'

describe('Checkbox', () => {
  it('is a native checkbox drawn with the app style', () => {
    const onChange = vi.fn()
    render(<Checkbox aria-label="include" onChange={onChange} />)
    const box = screen.getByRole('checkbox', { name: 'include' })
    expect(box).toHaveAttribute('data-slot', 'checkbox')
    expect(box.className).toContain('appearance-none')
    fireEvent.click(box)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(box).toBeChecked()
  })

  it('lets a caller change the size', () => {
    render(<Checkbox aria-label="small" className="size-3.5" />)
    const cls = screen.getByRole('checkbox').className
    expect(cls).toContain('size-3.5')
    expect(cls).not.toContain('size-4')
  })
})
