import { describe, expect, it, vi } from 'vitest'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { Frame, FrameBody, FrameHeader } from '../frame'
import { Segmented } from '../segmented'
import { Chip } from '../chip'
import { EmptyState } from '../empty-state'

describe('Frame', () => {
  it('renders a titled section with actions and a body', () => {
    render(
      <Frame aria-label="Usage">
        <FrameHeader title="Usage" actions={<button>More</button>} />
        <FrameBody>content</FrameBody>
      </Frame>
    )
    expect(screen.getByRole('heading', { name: 'Usage' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
    expect(screen.getByText('content')).toHaveAttribute('data-slot', 'frame-body')
  })
})

describe('Segmented', () => {
  const options = [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month', disabled: true },
  ] as const

  it('marks the selected option and reports clicks', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        aria-label="Range"
        options={[...options]}
        value="week"
        onValueChange={onChange}
      />
    )
    expect(screen.getByRole('radio', { name: 'Week' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Day' }))
    expect(onChange).toHaveBeenCalledWith('day')
  })

  it('moves with arrow keys and skips disabled options', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        aria-label="Range"
        options={[...options]}
        value="week"
        onValueChange={onChange}
      />
    )
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Week' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('day')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Week' }), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('day')
  })
})

describe('Chip and EmptyState', () => {
  it('renders a chip with its tone', () => {
    render(<Chip tone="ok" dot>Running</Chip>)
    expect(screen.getByText('Running')).toHaveAttribute('data-tone', 'ok')
  })

  it('renders an empty state with its action', () => {
    render(<EmptyState title="No chats" description="Start one" action={<button>New chat</button>} />)
    expect(screen.getByText('No chats')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument()
  })
})

describe('EmptyState motion', () => {
  it('tilts the tile toward the pointer and resets on leave', () => {
    render(<EmptyState icon={<svg />} title="Nothing" />)
    const root = document.querySelector(
      '[data-slot="empty-state"]'
    ) as HTMLElement
    const tile = document.querySelector(
      '[data-slot="empty-state-tile"]'
    ) as HTMLElement
    const ev = createEvent.pointerMove(root)
    Object.defineProperty(ev, 'clientX', { value: 500 })
    Object.defineProperty(ev, 'clientY', { value: 0 })
    fireEvent(root, ev)
    expect(tile.style.transform).toContain('perspective(260px)')
    expect(tile.style.transform).toContain('rotateY(14deg)')
    fireEvent.pointerLeave(root)
    expect(tile.style.transform).toBe('')
  })

  it('renders orbit dots and staggers description and action', () => {
    render(
      <EmptyState
        icon={<svg />}
        title="T"
        description="D"
        action={<button>Go</button>}
      />
    )
    expect(document.querySelectorAll('.es-orb')).toHaveLength(2)
    expect(screen.getByText('D')).toHaveStyle({ animationDelay: '80ms' })
    expect(
      screen.getByRole('button', { name: 'Go' }).parentElement
    ).toHaveStyle({ animationDelay: '160ms' })
  })
})
