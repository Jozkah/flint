import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryScopeTabs } from '../MemoryScopeTabs'
import { MemoryClearDialog, MemoryEditDialog } from '../MemoryDialogs'
import { MemoryImportReport } from '../MemoryImportReport'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

describe('MemoryScopeTabs', () => {
  it('marks the shown scope, shows counts, and reports a pick', async () => {
    const onSelect = vi.fn()
    render(
      <MemoryScopeTabs
        scope="user"
        onSelect={onSelect}
        tabCount={(s) => (s === 'chat' ? null : s === 'project' ? 2 : 5)}
      />
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs.filter((x) => x.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    expect(screen.queryByTestId('memory-tab-count-chat')).toBeNull()
    expect(screen.getByTestId('memory-tab-count-project').textContent).toBe('2')
    expect(screen.getByTestId('memory-tab-count-user').textContent).toBe('5')
    await userEvent.click(tabs[0])
    expect(onSelect).toHaveBeenCalledWith('chat')
  })
})

describe('MemoryEditDialog', () => {
  const editing = { id: 'm1' } as never
  it('saves only with text; typing and cancel are forwarded', async () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    const onDraftChange = vi.fn()
    const props = { editing, busy: false, onDraftChange, onClose, onSave }
    const { rerender } = render(<MemoryEditDialog {...props} draft="  " />)
    expect((screen.getByTestId('memory-edit-save') as HTMLButtonElement).disabled).toBe(true)
    rerender(<MemoryEditDialog {...props} draft="hi" />)
    await userEvent.click(screen.getByTestId('memory-edit-save'))
    expect(onSave).toHaveBeenCalledTimes(1)
    await userEvent.type(screen.getByRole('textbox'), 'x')
    expect(onDraftChange).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders nothing while closed', () => {
    render(
      <MemoryEditDialog editing={null} draft="" busy={false} onDraftChange={vi.fn()} onClose={vi.fn()} onSave={vi.fn()} />
    )
    expect(screen.queryByTestId('memory-edit-save')).toBeNull()
  })
})

describe('MemoryClearDialog', () => {
  it('confirms, and is disabled while busy', async () => {
    const onConfirm = vi.fn()
    const { rerender } = render(
      <MemoryClearDialog clearing="chat" busy={false} onClose={vi.fn()} onConfirm={onConfirm} />
    )
    await userEvent.click(screen.getByTestId('memory-clear-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    rerender(<MemoryClearDialog clearing="chat" busy onClose={vi.fn()} onConfirm={onConfirm} />)
    expect((screen.getByTestId('memory-clear-confirm') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('MemoryImportReport', () => {
  it('shows counts and refused records', () => {
    render(
      <MemoryImportReport
        report={
          {
            exportId: 'exp-1',
            imported: ['a', 'b'],
            duplicates: ['c'],
            refused: [{ index: 0, originalId: 'zz', reason: 'bad' }],
          } as never
        }
      />
    )
    const el = screen.getByTestId('memory-import-report')
    expect(el.getAttribute('data-imported')).toBe('2')
    expect(el.getAttribute('data-duplicates')).toBe('1')
    expect(el.getAttribute('data-refused')).toBe('1')
    expect(screen.getByTestId('memory-import-refused').textContent).toContain('bad')
  })
})
