import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BulkConversationsDialog } from '../BulkConversationsDialog'
import {
  BulkKept,
  BulkSkipped,
  type BulkItem,
  type BulkPlan,
} from '@/lib/bulkConversations'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

const it1 = (kind: BulkItem['kind'], id: string): BulkItem => ({ kind, id, title: `title-${id}` })

const plan = (action: BulkPlan['action']): BulkPlan => ({
  action,
  items: [it1('thread', 'a'), it1('thread', 'b'), it1('cowork', 'c')],
  skipped: [
    { item: { ...it1('thread', 'p'), pinned: true }, reason: 'pinned' },
    { item: { ...it1('room', 'r'), active: true }, reason: 'active' },
  ],
})

const setup = (over: Partial<Parameters<typeof BulkConversationsDialog>[0]> = {}) => {
  const act = vi.fn().mockResolvedValue(undefined)
  const onOpenChange = vi.fn()
  const onFinished = vi.fn()
  render(
    <BulkConversationsDialog
      open
      onOpenChange={onOpenChange}
      plan={plan('delete')}
      act={act}
      onFinished={onFinished}
      {...over}
    />
  )
  return { act, onOpenChange, onFinished }
}

describe('BulkConversationsDialog delete', () => {
  it('states what goes, what is skipped and that project folders stay', () => {
    setup()
    const list = screen.getByTestId('bulk-list').textContent ?? ''
    expect(list).toContain('Chats: 2')
    expect(list).toContain('Cowork sessions: 1')
    expect(list).toContain('worktree')
    expect(screen.getByTestId('bulk-skips').textContent).toContain('pinned: 1')
    expect(screen.getByTestId('bulk-skips').textContent).toContain('running: 1')
    expect(screen.getByText(/project folders are never deleted/i)).toBeTruthy()
  })

  it('stays locked until the word is typed, and deletes nothing before', async () => {
    const { act } = setup()
    const confirm = screen.getByTestId('bulk-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('bulk-confirm-input'), { target: { value: 'delet' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('bulk-confirm-input'), { target: { value: ' Delete ' } })
    expect(confirm.disabled).toBe(false)
    expect(act).not.toHaveBeenCalled()
    fireEvent.click(confirm)
    await waitFor(() => expect(screen.getByTestId('bulk-summary')).toBeTruthy())
    expect(act).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('bulk-summary').textContent).toBe('Deleted 3 items.')
    // Delete has no undo.
    expect(screen.queryByTestId('bulk-undo')).toBeNull()
  })

  it('reports each failure and the sessions kept in the Archive', async () => {
    const act = vi.fn(async (i: BulkItem) => {
      if (i.id === 'b') throw new Error('locked file')
      if (i.id === 'c') throw new BulkKept('unmerged work')
    })
    const { onFinished } = setup({ act })
    fireEvent.change(screen.getByTestId('bulk-confirm-input'), { target: { value: 'delete' } })
    fireEvent.click(screen.getByTestId('bulk-confirm'))
    await waitFor(() => expect(screen.getByTestId('bulk-problems')).toBeTruthy())
    const text = screen.getByTestId('bulk-problems').textContent ?? ''
    expect(text).toContain('title-b: locked file')
    expect(text).toContain('title-c: kept in the Archive. unmerged work')
    expect(screen.getByTestId('bulk-summary').textContent).toBe('Deleted 1 item.')
    expect(onFinished).toHaveBeenCalled()
  })

  it('can be stopped and says what was left alone', async () => {
    let release: () => void = () => undefined
    const act = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    setup({ act })
    fireEvent.change(screen.getByTestId('bulk-confirm-input'), { target: { value: 'delete' } })
    fireEvent.click(screen.getByTestId('bulk-confirm'))
    const stop = await screen.findByTestId('bulk-stop')
    fireEvent.click(stop)
    release()
    await waitFor(() => expect(screen.getByTestId('bulk-summary')).toBeTruthy())
    expect(act).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Stopped early\. 2 left untouched/)).toBeTruthy()
  })
})

describe('BulkConversationsDialog start checks', () => {
  it('refuses to run an archive when it was turned off since the dialog opened', async () => {
    const canStart = vi.fn().mockResolvedValue(false)
    const { act } = setup({ plan: plan('archive'), canStart })
    fireEvent.click(screen.getByTestId('bulk-confirm'))
    await waitFor(() => expect(screen.getByTestId('bulk-refused')).toBeTruthy())
    expect(act).not.toHaveBeenCalled()
  })

  it('lists an item skipped because it started running', async () => {
    const act = vi.fn(async (i: BulkItem) => {
      if (i.id === 'b') throw new BulkSkipped('running')
    })
    setup({ plan: plan('archive'), act })
    fireEvent.click(screen.getByTestId('bulk-confirm'))
    await waitFor(() => expect(screen.getByTestId('bulk-problems')).toBeTruthy())
    expect(screen.getByTestId('bulk-problems').textContent).toContain('title-b: skipped, it started running')
  })
})

describe('BulkConversationsDialog archive', () => {
  it('says campaigns are not archived instead of dropping them silently', () => {
    const archive = plan('archive')
    archive.skipped.push({ item: it1('campaign', 'k'), reason: 'unsupported' })
    setup({ plan: archive })
    expect(screen.getByTestId('bulk-skips').textContent).toContain('campaigns have no archive: 1')
  })

  it('shows why an undo failed instead of hanging', async () => {
    const undo = vi.fn().mockRejectedValue(new Error('Unknown command'))
    setup({ plan: plan('archive'), undo })
    fireEvent.click(screen.getByTestId('bulk-confirm'))
    await waitFor(() => expect(screen.getByTestId('bulk-undo')).toBeTruthy())
    fireEvent.click(screen.getByTestId('bulk-undo'))
    await waitFor(() => expect(screen.getByTestId('bulk-undone')).toBeTruthy())
    const text = screen.getByTestId('bulk-undone').textContent ?? ''
    expect(text).toContain('3 could not be restored')
    expect(text).toContain('Unknown command')
  })

  it('needs no typed word and offers undo that restores what it moved', async () => {
    const undo = vi.fn().mockResolvedValue({ restored: 3, failed: [] })
    const onOpenArchive = vi.fn()
    const { act } = setup({ plan: plan('archive'), undo, onOpenArchive })
    expect(screen.queryByTestId('bulk-confirm-input')).toBeNull()
    fireEvent.click(screen.getByTestId('bulk-confirm'))
    await waitFor(() => expect(screen.getByTestId('bulk-summary')).toBeTruthy())
    expect(act).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('bulk-summary').textContent).toBe('Archived 3 items.')
    fireEvent.click(screen.getByTestId('bulk-undo'))
    await waitFor(() => expect(screen.getByTestId('bulk-undone')).toBeTruthy())
    expect(undo).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'a' }),
      expect.objectContaining({ id: 'b' }),
      expect.objectContaining({ id: 'c' }),
    ])
    expect(screen.getByTestId('bulk-undone').textContent).toContain('Restored 3')
  })
})
