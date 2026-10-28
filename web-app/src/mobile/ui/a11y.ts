import type { KeyboardEvent } from 'react'

/**
 * Props that make a non-button element behave like one: focusable, and
 * activated by Enter or Space as well as by a tap.
 */
export function activate(run: () => void) {
  return {
    tabIndex: 0,
    onClick: run,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        run()
      }
    },
  }
}
