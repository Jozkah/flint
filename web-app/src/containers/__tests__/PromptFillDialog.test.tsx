import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { PromptFillDialog } from '../PromptFillDialog'
import type { LibraryPrompt } from '@/lib/promptLibrary'

const prompt = (body: string): LibraryPrompt => ({
  id: 'p1',
  name: 'Brief',
  body,
  createdAt: 1,
  updatedAt: 1,
})

describe('PromptFillDialog', () => {
  it('asks for each variable once and submits the filled text', () => {
    const onSubmit = vi.fn()
    render(
      <PromptFillDialog
        prompt={prompt('Write about {{topic}} for {{who:everyone}}. Again: {{topic}}')}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getAllByRole('textbox')).toHaveLength(2)
    const insert = screen.getByRole('button', { name: /insert|promptLibrary/i })
    // the required variable is empty, so submit is blocked
    expect(insert).toBeDisabled()
    fireEvent.change(screen.getByLabelText('topic'), { target: { value: 'cats' } })
    expect(insert).toBeEnabled()
    fireEvent.click(insert)
    expect(onSubmit).toHaveBeenCalledWith('Write about cats for everyone. Again: cats')
  })

  it('cancel inserts nothing', () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render(<PromptFillDialog prompt={prompt('{{a}}')} onSubmit={onSubmit} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('renders nothing without a prompt', () => {
    render(<PromptFillDialog prompt={null} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByTestId('prompt-fill-dialog')).toBeNull()
  })
})
