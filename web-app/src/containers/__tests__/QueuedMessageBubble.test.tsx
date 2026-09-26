import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { QueuedMessageChip } from '../QueuedMessageBubble'

describe('QueuedMessageChip', () => {
  const baseMessage = {
    id: 'queued-1',
    text: 'This is a queued message',
    createdAt: Date.now(),
  }

  it('renders the message text', () => {
    render(<QueuedMessageChip message={baseMessage} />)
    expect(screen.getByText('This is a queued message')).toBeInTheDocument()
  })

  it('renders a still clock icon: queued is waiting, not activity', () => {
    const { container } = render(<QueuedMessageChip message={baseMessage} />)
    expect(container.querySelector('svg')).toBeInTheDocument()
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  it('calls onRemove with the message id when X is clicked', () => {
    const onRemove = vi.fn()
    render(<QueuedMessageChip message={baseMessage} onRemove={onRemove} />)
    screen.getByTestId('queued-remove').click()
    expect(onRemove).toHaveBeenCalledWith('queued-1')
  })

  it('renders no buttons when no actions are provided', () => {
    const { container } = render(<QueuedMessageChip message={baseMessage} />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('calls onEdit with the full message when text or pencil is clicked', () => {
    const onEdit = vi.fn()
    render(<QueuedMessageChip message={baseMessage} onEdit={onEdit} />)
    screen.getByText('This is a queued message').click()
    screen.getByTestId('queued-edit').click()
    expect(onEdit).toHaveBeenCalledTimes(2)
    expect(onEdit).toHaveBeenCalledWith(baseMessage)
  })

  it('offers Steer now while a run works, and reorders', () => {
    const onSteer = vi.fn()
    const onMoveUp = vi.fn()
    const onMoveDown = vi.fn()
    render(
      <QueuedMessageChip
        message={baseMessage}
        onSteer={onSteer}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
      />
    )
    screen.getByText('common:queue.steer').click()
    screen.getByTestId('queued-move-up').click()
    screen.getByTestId('queued-move-down').click()
    expect(onSteer).toHaveBeenCalledWith('queued-1')
    expect(onMoveUp).toHaveBeenCalledWith('queued-1')
    expect(onMoveDown).toHaveBeenCalledWith('queued-1')
  })

  it('shows a message marked to steer as steering, with no second Steer button', () => {
    render(
      <QueuedMessageChip message={{ ...baseMessage, steer: true }} onSteer={vi.fn()} />
    )
    expect(screen.getByTestId('queued-steering')).toHaveTextContent('common:queue.steering')
    expect(screen.queryByTestId('queued-steer')).toBeNull()
  })
})
