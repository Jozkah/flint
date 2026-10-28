import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

import { TaskDetailsPanel, TaskStoryPanel, TaskStuckBox } from '../TaskRowPanels'

const task = {
  id: 't1',
  title: 'Task one',
  brief: 'Do the thing',
  status: 'failed',
  attempt: 1,
  tokensUsed: 1234,
  detail: 'it broke',
  branch: 'flint/t1',
} as never

const can = (over: Record<string, boolean> = {}) =>
  ({ open: true, note: true, handoff: true, skip: true, stop: false, retry: true, verify: false, accept: true, resolve: false, ...over }) as never

describe('TaskStuckBox', () => {
  const setup = (over: Record<string, unknown> = {}) => {
    const props = {
      task,
      reason: 'the error text',
      next: 'retry',
      conflictFiles: [],
      blockedTitles: ['Other task'],
      hint: 'try again',
      onHintChange: vi.fn(),
      accepting: false,
      onAcceptingChange: vi.fn(),
      acceptReason: '',
      onAcceptReasonChange: vi.fn(),
      can: can(),
      recovery: null,
      failed: true,
      busy: false,
      onAction: vi.fn(),
      ...over,
    }
    render(<TaskStuckBox {...(props as never)} />)
    return props
  }

  it('shows the reason, what it blocks and sends the hint with Retry', async () => {
    const p = setup()
    expect(screen.getByTestId('campaign-error-t1')).toHaveTextContent('the error text')
    expect(screen.getByTestId('campaign-blocks-t1')).toHaveTextContent('Other task')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(p.onAction).toHaveBeenCalledWith('retry', task, 'try again')
  })

  it('opens the accept form and confirms with the typed reason', async () => {
    const closed = setup()
    await userEvent.click(screen.getByTestId('campaign-accept-t1'))
    expect(closed.onAcceptingChange).toHaveBeenCalledWith(true)
  })

  it('confirming an accept hands over the trimmed reason and closes the form', async () => {
    const p = setup({ accepting: true, acceptReason: '  fine  ' })
    await userEvent.click(screen.getByTestId('campaign-accept-confirm-t1'))
    expect(p.onAction).toHaveBeenCalledWith('accept', task, 'fine')
    expect(p.onAcceptingChange).toHaveBeenCalledWith(false)
    expect(p.onAcceptReasonChange).toHaveBeenCalledWith('')
  })

  it('lists conflicting files for a conflict', () => {
    setup({ next: 'conflict', conflictFiles: ['a.ts', 'b.ts'], can: can({ resolve: true }) })
    expect(screen.getByTestId('campaign-conflict-files-t1')).toHaveTextContent('a.ts')
    expect(screen.getByTestId('campaign-resolve-t1')).toBeInTheDocument()
  })
})

describe('TaskStoryPanel', () => {
  it('shows the ask, a no-record note and the stopped-at line', () => {
    render(
      <TaskStoryPanel id="s" task={task} groups={[]} failedOrStuck headlineText="It stopped here" />
    )
    expect(screen.getByTestId('campaign-story-t1')).toBeInTheDocument()
    expect(screen.getByText('Do the thing')).toBeInTheDocument()
    expect(screen.getByText('It stopped here')).toBeInTheDocument()
  })

  it('caps the steps at twelve and counts the rest', () => {
    const groups = Array.from({ length: 15 }, () => ({ kind: 'read', ok: true, steps: [{ label: 'x' }] }))
    render(
      <TaskStoryPanel id="s" task={task} groups={groups as never} failedOrStuck={false} headlineText="" />
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(13)
  })
})

describe('TaskDetailsPanel', () => {
  it('shows branch, attempts and routes the note/handoff actions', async () => {
    const onAction = vi.fn()
    render(
      <TaskDetailsPanel
        id="d"
        task={task}
        check={null as never}
        can={can()}
        failed
        stuck={false}
        recovery={null as never}
        onAction={onAction}
      />
    )
    expect(screen.getByText('flint/t1')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Send note' }))
    expect(onAction).toHaveBeenCalledWith('note', task)
  })
})
