import { describe, it, expect, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ScrubField } from '../ui/scrub-field'
import { dragX } from './pointer'

function setup(props: Partial<ComponentProps<typeof ScrubField>> = {}) {
  const onCommit = vi.fn()
  render(
    <ScrubField
      label="Rounds"
      value={10}
      min={1}
      max={50}
      onCommit={onCommit}
      {...props}
    />
  )
  const input = screen.getByLabelText('Rounds') as HTMLInputElement
  return { input, onCommit, root: input.parentElement as HTMLElement }
}

describe('ScrubField', () => {
  it('keeps the labelled number input with its bounds', () => {
    const { input } = setup()
    expect(input).toHaveAttribute('type', 'number')
    expect(input).toHaveAttribute('min', '1')
    expect(input).toHaveAttribute('max', '50')
    expect(input.value).toBe('10')
  })

  it('typing commits on blur, as before', () => {
    const { input, onCommit } = setup()
    fireEvent.change(input, { target: { value: '12' } })
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith(12)
  })

  it('does not commit a number that is not one', () => {
    const { input, onCommit } = setup()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a drag scrubs one step per 2px and shows the delta', () => {
    const { input, root } = setup()
    dragX(root, [100, 110, 126], 0, false)
    // 26px right, 6px to arm... the value follows the full travel: 13 steps.
    expect(input.value).toBe('23')
    expect(root).toHaveAttribute('data-dragging', 'true')
    expect(screen.getByTestId('scrub-delta')).toHaveTextContent('+13')
  })

  it('commits the scrubbed value once on release', () => {
    const { input, onCommit, root } = setup()
    dragX(root, [100, 110, 116])
    expect(input.value).toBe('18')
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(18)
    expect(root).toHaveAttribute('data-dragging', 'false')
  })

  it('dragging left lowers it and shows a minus', () => {
    const { input, root } = setup()
    dragX(root, [100, 90, 80], 0, false)
    expect(input.value).toBe('1')
    expect(screen.getByTestId('scrub-delta')).toHaveTextContent('−9')
  })

  it('stops at the limits and pulls the field a little past them', () => {
    const { input, root } = setup()
    dragX(root, [0, 20, 400], 0, false)
    expect(input.value).toBe('50')
    expect(root).toHaveAttribute('data-over', 'true')
    expect(root.style.transform).toMatch(/translateX\(/)
    dragX(root, [400])
    expect(root).toHaveAttribute('data-over', 'false')
    expect(root.style.transform).toBe('')
  })

  it('a tap is not a scrub', () => {
    const { input, onCommit, root } = setup()
    dragX(root, [100, 101, 102])
    expect(input.value).toBe('10')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a disabled field does not scrub', () => {
    const { input, root } = setup({ disabled: true })
    dragX(root, [100, 140])
    expect(input.value).toBe('10')
  })
})
