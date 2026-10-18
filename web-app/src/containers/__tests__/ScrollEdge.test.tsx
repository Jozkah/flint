import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SettingsPageBody } from '../SettingsPageHeader'

// The shell pane keeps a 12px gutter (`px-3`) and its page slot cancels it
// (`-mr-3`). A page's scroll container pulls back out with `-mr-3` and moves
// the gutter inside as padding, so the scrollbar sits on the pane's right edge
// instead of floating in from it.
const classesOf = (el: Element | null) => (el?.className ?? '').split(/\s+/)

describe('scroll container reaches the pane edge', () => {
  it('SettingsPageBody scrolls full width, with the gutter as padding', () => {
    const { container } = render(
      <SettingsPageBody testId="body">
        <div>one</div>
      </SettingsPageBody>
    )
    const scroller = container.querySelector('.overflow-y-auto')
    expect(classesOf(scroller)).toContain('-mr-3')
    expect(classesOf(scroller)).toContain('pr-4')
    expect(classesOf(scroller?.parentElement)).not.toContain('px-1')
  })
})
