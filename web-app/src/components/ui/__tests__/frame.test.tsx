import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Frame, FrameBody, FrameHeader } from '../frame'

const renderFrame = (collapseId?: string) =>
  render(
    <Frame collapseId={collapseId}>
      <FrameHeader title="Activity" />
      <FrameBody>body text</FrameBody>
    </Frame>
  )

describe('Frame collapse', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('has no toggle without a collapseId', () => {
    renderFrame()
    expect(screen.queryByTestId('frame-collapse-toggle')).toBeNull()
  })

  it('hides the body and remembers the choice per id', () => {
    const { unmount } = renderFrame('test-section')
    const toggle = screen.getByTestId('frame-collapse-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('body text')).not.toBeVisible()
    expect(window.localStorage.getItem('flint:frame-collapsed:test-section')).toBe('1')
    unmount()

    renderFrame('test-section')
    expect(screen.getByTestId('frame-collapse-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    fireEvent.click(screen.getByTestId('frame-collapse-toggle'))
    expect(window.localStorage.getItem('flint:frame-collapsed:test-section')).toBeNull()
  })
})
