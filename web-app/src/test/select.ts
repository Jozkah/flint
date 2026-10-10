import { act, fireEvent } from '@testing-library/react'

/** Open a `Select` and pick the option with this value. */
export function chooseOption(trigger: HTMLElement, value: string) {
  act(() => {
    fireEvent.keyDown(trigger, { key: 'Enter' })
  })
  const item = document.querySelector<HTMLElement>(
    `[role="menuitemradio"][data-value="${value}"]`
  )
  if (!item) throw new Error(`No option with value "${value}"`)
  fireEvent.click(item)
}
