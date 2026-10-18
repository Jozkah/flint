import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { IdleShutdownInput } from '../IdleShutdownInput'

const setup = (minutes = 15) => {
  const onCommit = vi.fn()
  const onBlur = vi.fn()
  render(<IdleShutdownInput minutes={minutes} onCommit={onCommit} onBlur={onBlur} />)
  return { input: screen.getByRole('spinbutton') as HTMLInputElement, onCommit, onBlur }
}

describe('IdleShutdownInput', () => {
  it('can be cleared and retyped; the new value commits on blur', () => {
    const { input, onCommit, onBlur } = setup()
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith(30)
    expect(onBlur).toHaveBeenCalled()
  })

  it('commits on Enter and reverts an empty entry', () => {
    const { input, onCommit } = setup(10)
    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith(5)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(input.value).toBe('10')
  })
})
