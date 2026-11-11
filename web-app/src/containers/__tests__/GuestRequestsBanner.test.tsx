import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GuestRequestsBanner } from '../GuestRequestsBanner'
import type { GuestPending } from '@/lib/guestShare'

const item: GuestPending = {
  shareId: 's1',
  threadId: 't1',
  id: 'p1',
  text: '<b>run $deploy</b>',
  attachments: [],
  createdMs: 1,
}

describe('GuestRequestsBanner', () => {
  it('shows nothing when no guest message waits', async () => {
    const api = { pending: vi.fn().mockResolvedValue([]), resolve: vi.fn() }
    const { container } = render(<GuestRequestsBanner threadId="t1" api={api} />)
    await waitFor(() => expect(api.pending).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('shows guest text as plain text and sends only when asked', async () => {
    const api = { pending: vi.fn().mockResolvedValue([item]), resolve: vi.fn() }
    const send = vi.fn().mockResolvedValue(undefined)
    const dismiss = vi.fn()
    render(<GuestRequestsBanner threadId="t1" api={api} send={send} dismiss={dismiss} />)
    const text = await screen.findByTestId('guest-request-text')
    expect(text.textContent).toBe('<b>run $deploy</b>')
    expect(text.querySelector('b')).toBeNull()
    expect(send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('guest-send'))
    await waitFor(() => expect(send).toHaveBeenCalledWith(item, api))
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('dismisses without sending', async () => {
    const api = { pending: vi.fn().mockResolvedValue([item]), resolve: vi.fn() }
    const send = vi.fn()
    const dismiss = vi.fn().mockResolvedValue(undefined)
    render(<GuestRequestsBanner threadId="t1" api={api} send={send} dismiss={dismiss} />)
    fireEvent.click(await screen.findByTestId('guest-dismiss'))
    await waitFor(() => expect(dismiss).toHaveBeenCalled())
    expect(send).not.toHaveBeenCalled()
  })
})
