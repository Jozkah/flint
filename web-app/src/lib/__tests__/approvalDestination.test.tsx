import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  approvalDestination,
  openApprovalDestination,
  scrollToApproval,
} from '../approvalDestination'
import { approvalReminderContent } from '@/hooks/useApprovalWaitNotifier'

const known = { coworkSessionIds: ['cw-1'], roomIds: ['room-1'] }

describe('approval reminder destination', () => {
  it('names the surface the waiting conversation lives on', () => {
    expect(approvalDestination('cw-1', known)).toEqual({ kind: 'cowork', id: 'cw-1' })
    expect(approvalDestination('room-1', known)).toEqual({ kind: 'room', id: 'room-1' })
    expect(approvalDestination('t-9', known)).toEqual({ kind: 'thread', id: 't-9' })
  })

  it('selects a Cowork session before opening Cowork', () => {
    const navigate = vi.fn()
    const select = vi.fn()
    openApprovalDestination({ kind: 'cowork', id: 'cw-1' }, navigate, select)
    expect(select).toHaveBeenCalledWith('cw-1')
    expect(navigate).toHaveBeenCalledWith({ to: '/cowork' })
  })

  it('opens a room and a chat thread by id', () => {
    const navigate = vi.fn()
    const select = vi.fn()
    openApprovalDestination({ kind: 'room', id: 'room-1' }, navigate, select)
    openApprovalDestination({ kind: 'thread', id: 't-9' }, navigate, select)
    expect(navigate).toHaveBeenNthCalledWith(1, {
      to: '/rooms/$roomId',
      params: { roomId: 'room-1' },
    })
    expect(navigate).toHaveBeenNthCalledWith(2, {
      to: '/threads/$threadId',
      params: { threadId: 't-9' },
    })
    expect(select).not.toHaveBeenCalled()
  })
})

describe('scrolling to the prompt', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('scrolls to the prompt once it renders', async () => {
    const card = document.createElement('div')
    card.setAttribute('data-approval-request', 'req-1')
    const scroll = vi.fn()
    card.scrollIntoView = scroll
    setTimeout(() => document.body.appendChild(card), 5)
    await expect(scrollToApproval('req-1', { everyMs: 5 })).resolves.toBe(true)
    expect(scroll).toHaveBeenCalled()
  })

  it('gives up quietly when the prompt never appears', async () => {
    await expect(
      scrollToApproval('gone', { tries: 2, everyMs: 1 })
    ).resolves.toBe(false)
  })
})

describe('the reminder toast content', () => {
  it('is one button that opens the conversation on click and Enter', () => {
    const open = vi.fn()
    render(
      approvalReminderContent(
        'Waiting for your approval: bash',
        'The run has been paused for 30 s until you allow or deny it.',
        open
      )
    )
    const button = screen.getByRole('button', {
      name: /Waiting for your approval: bash/,
    })
    expect(button.className).toContain('cursor-pointer')
    fireEvent.click(button)
    expect(open).toHaveBeenCalledTimes(1)
    // A native button: Enter and Space activate it through click.
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
  })
})

describe('opening a waiting approval from its reminder', () => {
  it('selects the Cowork session, navigates and dismisses the toast', async () => {
    const { openWaitingApproval } = await import('@/hooks/useApprovalWaitNotifier')
    const { useCoworkSessions } = await import('@/hooks/useCoworkSessions')
    const { toast } = await import('sonner')
    const dismiss = vi.spyOn(toast, 'dismiss')
    const select = vi.fn()
    useCoworkSessions.setState({
      sessions: [{ id: 'cw-7' } as never],
      selectSession: select,
    })
    const navigate = vi.fn()
    openWaitingApproval({ requestId: 'req-7', threadId: 'cw-7' }, navigate)
    expect(select).toHaveBeenCalledWith('cw-7')
    expect(navigate).toHaveBeenCalledWith({ to: '/cowork' })
    expect(dismiss).toHaveBeenCalledWith('approval-wait-req-7')
  })
})
