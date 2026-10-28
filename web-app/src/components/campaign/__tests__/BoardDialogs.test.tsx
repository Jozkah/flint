import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

import { BoardDialogs, type BoardPanel } from '../BoardDialogs'

const task = { id: 't1', title: 'Task one', sessionId: 's1' } as never

const setup = (panel: BoardPanel, over: Record<string, unknown> = {}) => {
  const actions = {
    sendNote: vi.fn(),
    finalize: vi.fn(),
    skipCascade: vi.fn(),
    releaseDependants: vi.fn(),
    cancel: vi.fn(),
  }
  const run = vi.fn(async (work: () => Promise<unknown>) => {
    await work()
  })
  const onClose = vi.fn()
  const onPrimary = vi.fn()
  render(
    <BoardDialogs
      panel={panel}
      onClose={onClose}
      campaign={{ id: 'c1', title: 'Ship it', tasks: [] }}
      actions={actions as never}
      busy={false}
      run={run}
      note="hello"
      onNoteChange={vi.fn()}
      activity={{}}
      primary={'pause' as never}
      onPrimary={onPrimary}
      {...over}
    />
  )
  return { actions, run, onClose, onPrimary }
}

describe('BoardDialogs', () => {
  it('renders nothing while no panel is open', () => {
    setup(null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('sends the note for the task and closes', async () => {
    const { actions, onClose } = setup({ kind: 'note', task })
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onClose).toHaveBeenCalled()
    expect(actions.sendNote).toHaveBeenCalledWith('c1', 't1', 'hello')
  })

  it('does not send an empty note', () => {
    setup({ kind: 'note', task }, { note: '  ' })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('skips with cascade or release, naming the task', async () => {
    const a = setup({ kind: 'skipConfirm', task, count: 2 })
    await userEvent.click(screen.getByTestId('campaign-skip-cascade'))
    expect(a.actions.skipCascade).toHaveBeenCalledWith('c1', 't1')
    await userEvent.click(screen.getByTestId('campaign-skip-release'))
    expect(a.actions.releaseDependants).toHaveBeenCalledWith('c1', 't1')
  })

  it('confirms a cancel', async () => {
    const { actions } = setup({ kind: 'cancel' })
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(actions.cancel).toHaveBeenCalledWith('c1')
  })

  it('finalizes from the review dialog', async () => {
    const { actions } = setup({ kind: 'review', command: 'npm test' })
    expect(screen.getByText(/npm test/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /review/i }))
    expect(actions.finalize).toHaveBeenCalledWith('c1')
  })

  it('shows handoff text', () => {
    setup({ kind: 'handoff', task, text: 'the handoff body' })
    expect(screen.getByText('the handoff body')).toBeInTheDocument()
  })
})
