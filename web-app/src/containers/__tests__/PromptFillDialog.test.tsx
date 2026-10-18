import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { PromptFillDialog } from '../PromptFillDialog'
import type { LibraryPrompt } from '@/lib/promptLibrary'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, string>) =>
      o ? `${k} ${Object.values(o).join(' ')}` : k,
  }),
}))

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

  it('marks defaults as defaults, marks required fields and says why Insert is off', () => {
    render(
      <PromptFillDialog
        prompt={prompt('{{topic}} in {{lang:TypeScript}}')}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    // A default reads as a default, never as a typed value.
    expect(screen.getByLabelText('lang')).toHaveAttribute(
      'placeholder',
      expect.stringContaining('TypeScript')
    )
    expect(screen.getByLabelText('lang').getAttribute('placeholder')).not.toBe('TypeScript')
    expect(screen.getByLabelText('lang')).toHaveAttribute('aria-required', 'false')
    expect(screen.getByLabelText('topic')).toHaveAttribute('aria-required', 'true')
    // Why Insert is disabled.
    expect(screen.getByRole('status')).toHaveTextContent('topic')
    fireEvent.change(screen.getByLabelText('topic'), { target: { value: 'x' } })
    expect(screen.queryByRole('status')).toBeNull()
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
