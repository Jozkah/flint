import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o ? `${k}#${o.count}` : k),
  }),
}))

import { CoworkHeldInput } from '../CoworkHeldInput'
import { useMessageQueue } from '@/stores/message-queue-store'

const q = () => useMessageQueue.getState()

describe('CoworkHeldInput (janhq/jan#8864)', () => {
  beforeEach(() => useMessageQueue.setState({ queues: {} }))

  it('shows only this session’s held input, and nothing when there is none', () => {
    q().enqueue('A', { id: '1', text: 'use pnpm', createdAt: 1 })
    q().enqueue('B', { id: '2', text: 'other session', createdAt: 1 })
    const { container, unmount } = render(
      <CoworkHeldInput sessionId="A" running={false} />
    )
    expect(container).toBeEmptyDOMElement()
    unmount()
    q().holdQueue('A')
    q().holdQueue('B')
    render(<CoworkHeldInput sessionId="A" running={false} />)
    expect(screen.getByTestId('cowork-held-input')).toHaveTextContent('use pnpm')
    expect(screen.getByTestId('cowork-held-input')).not.toHaveTextContent('other session')
    expect(screen.getByTestId('cowork-held-input')).toHaveTextContent('common:steering.held#1')
  })

  it('sends by releasing it, and discards by removing it', () => {
    q().enqueue('A', { id: '1', text: 'first', createdAt: 1 })
    q().enqueue('A', { id: '2', text: 'second', createdAt: 2 })
    q().holdQueue('A')
    render(<CoworkHeldInput sessionId="A" running={false} />)
    fireEvent.click(screen.getAllByTestId('cowork-held-send')[0])
    expect(q().getQueue('A').map((m) => [m.id, !!m.held])).toEqual([
      ['1', false],
      ['2', true],
    ])
    fireEvent.click(screen.getByTestId('cowork-held-discard'))
    expect(q().getQueue('A').map((m) => m.id)).toEqual(['1'])
  })

  it('cannot send while a run is going', () => {
    q().enqueue('A', { id: '1', text: 'first', createdAt: 1 })
    q().holdQueue('A')
    render(<CoworkHeldInput sessionId="A" running />)
    expect(screen.getByTestId('cowork-held-send')).toBeDisabled()
  })
})
