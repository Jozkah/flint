import { describe, it, expect, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AccessRequestDialog } from '../AccessRequestDialog'
import { useAccessRequests } from '@/lib/accessRequests'

function ask(overrides: Partial<{ mode: 'read' | 'write'; requested: string }> = {}) {
  return useAccessRequests.getState().ask({
    threadId: 't1',
    taskLabel: 'Check caveman plugin',
    reason: 'Read the plugin manifest to answer the question',
    prepared: {
      status: 'ok',
      display: 'D:\\projects\\notes',
      isDir: true,
      mode: overrides.mode ?? 'read',
      requested: overrides.requested ?? 'D:\\projects\\notes',
      resolvedDiffers: overrides.requested !== undefined,
    },
  })
}

describe('AccessRequestDialog', () => {
  beforeEach(() => useAccessRequests.setState({ queue: [], presenters: 0 }))

  it('counts as a presenter only while mounted', () => {
    const { unmount } = render(<AccessRequestDialog />)
    expect(useAccessRequests.getState().presenters).toBe(1)
    unmount()
    expect(useAccessRequests.getState().presenters).toBe(0)
  })

  it('shows the resolved path, reason, mode and asking task, with Deny focused', async () => {
    render(<AccessRequestDialog />)
    let answer!: Promise<unknown>
    act(() => {
      answer = ask({ requested: 'D:\\link-to-notes' })
    })
    expect(await screen.findByTestId('access-path')).toHaveTextContent('D:\\projects\\notes')
    expect(screen.getByText(/D:\\link-to-notes/)).toBeInTheDocument()
    expect(screen.getByTestId('access-reason')).toHaveTextContent('Read the plugin manifest')
    expect(screen.getByTestId('access-mode')).toHaveTextContent('Read only')
    expect(screen.getByText('Check caveman plugin')).toBeInTheDocument()
    expect(screen.getByTestId('access-deny')).toHaveFocus()
    fireEvent.click(screen.getByTestId('access-session'))
    await expect(answer).resolves.toBe('session')
  })

  it('marks a write request as read and write', async () => {
    render(<AccessRequestDialog />)
    act(() => {
      void ask({ mode: 'write' })
    })
    expect(await screen.findByTestId('access-mode')).toHaveTextContent('Read and write')
  })

  it('denies when dismissed with Escape', async () => {
    render(<AccessRequestDialog />)
    let answer!: Promise<unknown>
    act(() => {
      answer = ask()
    })
    await screen.findByTestId('access-request-dialog')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await expect(answer).resolves.toBe('deny')
  })

  it('answers Always allow explicitly', async () => {
    render(<AccessRequestDialog />)
    let answer!: Promise<unknown>
    act(() => {
      answer = ask()
    })
    fireEvent.click(await screen.findByTestId('access-always'))
    await expect(answer).resolves.toBe('always')
  })
})
