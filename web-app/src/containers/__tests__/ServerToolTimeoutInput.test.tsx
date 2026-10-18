import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ServerToolTimeoutInput } from '../ServerToolTimeoutInput'

const setup = (seconds?: number) => {
  const onCommit = vi.fn()
  render(
    <ServerToolTimeoutInput
      seconds={seconds}
      placeholder="60"
      ariaLabel="Tool timeout (s)"
      onCommit={onCommit}
    />
  )
  return { input: screen.getByRole('spinbutton') as HTMLInputElement, onCommit }
}

describe('ServerToolTimeoutInput', () => {
  it('reverts a negative entry instead of leaving it on screen', () => {
    const { input, onCommit } = setup(30)
    fireEvent.change(input, { target: { value: '-5' } })
    fireEvent.blur(input)
    expect(input.value).toBe('30')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('reverts zero when nothing was stored', () => {
    const { input, onCommit } = setup()
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(input.value).toBe('')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('floors a decimal and shows the stored whole number', () => {
    const { input, onCommit } = setup()
    fireEvent.change(input, { target: { value: '2.7' } })
    fireEvent.blur(input)
    expect(input.value).toBe('2')
    expect(onCommit).toHaveBeenCalledWith(2)
  })

  it('commits on Enter', () => {
    const { input, onCommit } = setup()
    fireEvent.change(input, { target: { value: '45' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith(45)
  })

  it('clearing the field removes the override', () => {
    const { input, onCommit } = setup(30)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith(undefined)
  })
})
