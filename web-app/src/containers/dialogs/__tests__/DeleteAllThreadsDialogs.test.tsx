import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

import { DeleteAllThreadsDialog } from '@/containers/dialogs/DeleteAllThreadsDialog'
import { DeleteAllThreadsInProjectDialog } from '@/containers/dialogs/DeleteAllThreadsInProjectDialog'

// janhq/jan#8183: the dialog opened with focus on the destructive button and
// deleted on Enter, so opening it and pressing Enter -- or pressing it twice
// to get past a menu -- removed every thread without a deliberate choice.
const cases = [
  {
    name: 'DeleteAllThreadsDialog',
    render: (onDeleteAll: () => void) => (
      <DeleteAllThreadsDialog onDeleteAll={onDeleteAll} />
    ),
  },
  {
    name: 'DeleteAllThreadsInProjectDialog',
    render: (onDeleteAll: () => void) => (
      <DeleteAllThreadsInProjectDialog
        projectName="p"
        threadCount={3}
        onDeleteAll={onDeleteAll}
      />
    ),
  },
]

function open(dialog: React.ReactNode) {
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>menu</DropdownMenuTrigger>
      <DropdownMenuContent>{dialog}</DropdownMenuContent>
    </DropdownMenu>
  )
  fireEvent.click(screen.getAllByText('common:deleteAll')[0])
}

describe.each(cases)('$name', ({ render: dialog }) => {
  it('opens with focus on Cancel, and Enter there deletes nothing', async () => {
    const onDeleteAll = vi.fn()
    open(dialog(onDeleteAll))
    const cancel = await screen.findByRole('button', { name: 'common:cancel' })
    await waitFor(() => expect(document.activeElement).toBe(cancel))

    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' })
    expect(onDeleteAll).not.toHaveBeenCalled()
  })

  it('deletes once, on a deliberate click of the destructive button', async () => {
    const onDeleteAll = vi.fn()
    open(dialog(onDeleteAll))
    const confirm = await screen.findByRole('button', { name: 'common:deleteAll' })
    fireEvent.keyDown(confirm, { key: 'Enter' })
    expect(onDeleteAll).not.toHaveBeenCalled()
    fireEvent.click(confirm)
    expect(onDeleteAll).toHaveBeenCalledTimes(1)
  })
})
