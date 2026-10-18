import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

const showUndoToast = vi.hoisted(() => vi.fn())
vi.mock('@/lib/toastUndo', () => ({ showUndoToast }))

import { PromptLibraryCard } from '../PromptLibraryCard'
import { usePromptLibrary } from '@/lib/promptLibrary'

describe('PromptLibraryCard delete', () => {
  beforeEach(() => {
    showUndoToast.mockReset()
    usePromptLibrary.setState({ prompts: [] })
    for (const name of ['A', 'B', 'C']) {
      usePromptLibrary.getState().add({ name, body: `body ${name}` })
    }
  })

  it('deletes at once and offers Undo that restores the prompt in place', () => {
    render(<PromptLibraryCard />)
    const before = usePromptLibrary.getState().prompts.map((p) => p.id)
    const deletes = screen.getAllByRole('button', { name: /delete/i })
    expect(deletes).toHaveLength(3)
    fireEvent.click(deletes[1]!)

    expect(usePromptLibrary.getState().prompts.map((p) => p.name)).toEqual(['A', 'C'])
    expect(showUndoToast).toHaveBeenCalledTimes(1)
    const opts = showUndoToast.mock.calls[0]![0]
    expect(opts.description).toBe('B')

    opts.onUndo()
    expect(usePromptLibrary.getState().prompts.map((p) => p.id)).toEqual(before)
    // a second Undo never duplicates it
    opts.onUndo()
    expect(usePromptLibrary.getState().prompts).toHaveLength(3)
  })
})
