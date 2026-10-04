import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { SliderControl } from '../SliderControl'

// A parent that feeds the new value straight back in, as the sampler popover
// does: every change produces a new array, which used to reset the typed text.
function Harness({ onValue }: { onValue?: (v: number) => void }) {
  const [value, setValue] = useState<number[]>([0.7])
  return (
    <SliderControl
      title="Temperature"
      min={0}
      max={2}
      step={0.01}
      value={value}
      onChange={(v) => {
        if (v) {
          setValue(v)
          onValue?.(v[0])
        }
      }}
    />
  )
}

async function retype(text: string) {
  const input = screen.getByRole('textbox') as HTMLInputElement
  const user = userEvent.setup()
  await user.clear(input)
  await user.type(input, text)
  return input
}

describe('SliderControl number field', () => {
  it('keeps the point while typing 0.5', async () => {
    const seen = vi.fn()
    render(<Harness onValue={seen} />)
    const input = await retype('0.5')
    expect(input.value).toBe('0.5')
    expect(seen).toHaveBeenLastCalledWith(0.5)
  })

  it('accepts a comma as the decimal separator', async () => {
    const seen = vi.fn()
    render(<Harness onValue={seen} />)
    const input = await retype('0,5')
    expect(input.value).toBe('0,5')
    expect(seen).toHaveBeenLastCalledWith(0.5)
  })

  it('accepts a leading point and a two-digit fraction', async () => {
    const seen = vi.fn()
    render(<Harness onValue={seen} />)
    const input = await retype('.75')
    expect(input.value).toBe('.75')
    expect(seen).toHaveBeenLastCalledWith(0.75)
    const again = await retype('1.12')
    expect(again.value).toBe('1.12')
    expect(seen).toHaveBeenLastCalledWith(1.12)
  })

  it('still follows the value when the parent changes it', () => {
    const { rerender } = render(
      <SliderControl min={0} max={2} step={0.01} value={[0.7]} />
    )
    rerender(<SliderControl min={0} max={2} step={0.01} value={[1.3]} />)
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('1.3')
  })
})
