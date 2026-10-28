import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AccessRequestDialog } from '../AccessRequestDialog'
import { useAccessRequests } from '@/lib/accessRequests'

// These tests read the words, so they use the real English strings.
vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

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
    await waitFor(() => expect(screen.getByTestId('access-session')).toBeEnabled())
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

  it('ignores a click outside the dialog', async () => {
    render(<AccessRequestDialog />)
    act(() => {
      void ask()
    })
    await screen.findByTestId('access-request-dialog')
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')!
    fireEvent.pointerDown(overlay)
    fireEvent.mouseDown(overlay)
    fireEvent.click(overlay)
    expect(screen.getByTestId('access-request-dialog')).toBeInTheDocument()
    expect(useAccessRequests.getState().queue).toHaveLength(1)
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
    const always = await screen.findByTestId('access-always')
    await waitFor(() => expect(always).toBeEnabled())
    fireEvent.click(always)
    await expect(answer).resolves.toBe('always')
  })

  it('holds the grant buttons briefly for each new request', async () => {
    render(<AccessRequestDialog />)
    act(() => {
      void ask()
      void ask({ requested: 'D:\other' })
    })
    await waitFor(() => expect(screen.getByTestId('access-session')).toBeEnabled())
    // Answering the first moves straight to the second, which starts held,
    // so a double click or Enter cannot grant it too.
    fireEvent.click(screen.getByTestId('access-session'))
    expect(await screen.findByText(/D:\other/)).toBeInTheDocument()
    expect(screen.getByTestId('access-session')).toBeDisabled()
    expect(screen.getByTestId('access-always')).toBeDisabled()
  })

  it('words the title and the waiting count through translations', async () => {
    render(<AccessRequestDialog />)
    act(() => {
      void ask()
    })
    expect(
      await screen.findByText('Allow the agent to read this folder?')
    ).toBeInTheDocument()
    expect(screen.queryByText(/more request/)).toBeNull()

    act(() => {
      void ask()
    })
    expect(await screen.findByText('1 more request waiting.')).toBeInTheDocument()

    act(() => {
      void ask()
      void ask()
    })
    expect(await screen.findByText('3 more requests waiting.')).toBeInTheDocument()
  })
})
