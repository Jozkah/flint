import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { DynamicControllerSetting } from '@/containers/dynamicControllerSetting'

/** A param row the way ParametersSection drives it: value in, number out. */
function Harness({
  initial,
  min,
  max,
  onValue,
}: {
  initial: number | string
  min?: number
  max?: number
  onValue: (v: unknown) => void
}) {
  const [value, setValue] = useState<string | number | boolean>(initial)
  return (
    <DynamicControllerSetting
      controllerType="input"
      controllerProps={{ value, min, max, step: 0.05 }}
      onChange={(v) => {
        onValue(v)
        setValue(v)
      }}
    />
  )
}

const field = () => screen.getByRole('textbox') as HTMLInputElement

describe('decimal parameter input', () => {
  it.each([
    ['0.5', 0.5],
    ['0,5', 0.5],
    ['.5', 0.5],
    [',5', 0.5],
  ])('lets you type %s', async (typed, expected) => {
    const onValue = vi.fn()
    render(<Harness initial={1} min={0} max={2} onValue={onValue} />)
    const user = userEvent.setup()
    await user.clear(field())
    await user.type(field(), typed)
    expect(field().value).toBe(typed)
    expect(onValue).toHaveBeenLastCalledWith(expected)
    await user.tab()
    expect(field().value).toBe('0.5')
  })

  it('keeps "0." and "0," on screen while typing and writes no NaN', async () => {
    const onValue = vi.fn()
    render(<Harness initial={1} min={0} max={2} onValue={onValue} />)
    const user = userEvent.setup()
    await user.clear(field())
    await user.type(field(), '0.')
    expect(field().value).toBe('0.')
    await user.clear(field())
    await user.type(field(), '0,')
    expect(field().value).toBe('0,')
    for (const [v] of onValue.mock.calls) {
      expect(Number.isNaN(v)).toBe(false)
    }
  })

  it('finishes "0." as 0 on blur', async () => {
    const onValue = vi.fn()
    render(<Harness initial={1} min={0} max={2} onValue={onValue} />)
    const user = userEvent.setup()
    await user.clear(field())
    await user.type(field(), '0.')
    await user.tab()
    expect(field().value).toBe('0')
    expect(onValue).toHaveBeenLastCalledWith(0)
  })

  it('ignores a keystroke that cannot be part of a number', async () => {
    const onValue = vi.fn()
    render(<Harness initial={1} onValue={onValue} />)
    const user = userEvent.setup()
    await user.clear(field())
    await user.type(field(), '1e')
    expect(field().value).toBe('1')
    expect(onValue).toHaveBeenLastCalledWith(1)
  })

  it('allows a lone minus and commits nothing for it on blur', async () => {
    const onValue = vi.fn()
    render(<Harness initial={0.7} onValue={onValue} />)
    const user = userEvent.setup()
    await user.clear(field())
    await user.type(field(), '-')
    expect(field().value).toBe('-')
    await user.tab()
    // Clearing already stored the empty value; "-" adds no number to it.
    expect(field().value).toBe('')
    expect(onValue).toHaveBeenLastCalledWith('')
    for (const [v] of onValue.mock.calls) expect(Number.isNaN(v)).toBe(false)
  })

  it('reports an emptied field as empty, never NaN', async () => {
    const onValue = vi.fn()
    render(<Harness initial={0.7} onValue={onValue} />)
    const user = userEvent.setup()
    await user.clear(field())
    expect(field().value).toBe('')
    expect(onValue).toHaveBeenLastCalledWith('')
  })

  it('clamps an out-of-range number only when editing ends', async () => {
    const onValue = vi.fn()
    render(<Harness initial={1} min={0} max={2} onValue={onValue} />)
    const user = userEvent.setup()
    await user.clear(field())
    await user.type(field(), '15')
    // Still showing what was typed, and the out-of-range 15 was never written.
    expect(field().value).toBe('15')
    expect(onValue.mock.calls.some(([v]) => v === 15)).toBe(false)
    await user.tab()
    expect(field().value).toBe('2')
    expect(onValue).toHaveBeenLastCalledWith(2)
  })

  it('clamps below the minimum on Enter', async () => {
    const onValue = vi.fn()
    render(<Harness initial={1} min={0} max={2} onValue={onValue} />)
    const user = userEvent.setup()
    await user.clear(field())
    await user.type(field(), '-4{Enter}')
    expect(field().value).toBe('0')
    expect(onValue).toHaveBeenLastCalledWith(0)
  })

  it('follows a value changed from outside', () => {
    const { rerender } = render(
      <DynamicControllerSetting
        controllerType="input"
        controllerProps={{ value: 0.2, min: 0, max: 2, step: 0.05 }}
        onChange={() => {}}
      />
    )
    expect(field().value).toBe('0.2')
    rerender(
      <DynamicControllerSetting
        controllerType="input"
        controllerProps={{ value: 0.9, min: 0, max: 2, step: 0.05 }}
        onChange={() => {}}
      />
    )
    expect(field().value).toBe('0.9')
  })

  it('steppers still move by the step', async () => {
    const onValue = vi.fn()
    render(<Harness initial={0.5} min={0} max={2} onValue={onValue} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Increment' }))
    expect(onValue).toHaveBeenLastCalledWith(0.55)
    expect(field().value).toBe('0.55')
  })
})
