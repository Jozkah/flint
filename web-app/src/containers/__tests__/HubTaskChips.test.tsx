import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { HubTaskChips } from '../HubTaskChips'
import { HuggingFaceLogo } from '@/components/icons/HuggingFaceLogo'

describe('HubTaskChips', () => {
  it('renders friendly primary chips and marks the selected one', () => {
    render(<HubTaskChips value="coding" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByRole('button', { name: 'Coding' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Small & fast' })).toBeTruthy()
    expect(screen.queryByText(/gguf|safetensors|text-generation/i)).toBeNull()
  })

  it('calls onChange with the task id, and All resets', () => {
    const onChange = vi.fn()
    render(<HubTaskChips value="chat" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }))
    expect(onChange).toHaveBeenCalledWith('reasoning')
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(onChange).toHaveBeenCalledWith('all')
  })

  it('shows a hidden selection on the More chip', () => {
    render(<HubTaskChips value="translation" onChange={() => {}} />)
    expect(
      screen.getByRole('button', { name: 'More ways to browse' })
    ).toHaveTextContent('Translation')
  })
})

describe('HuggingFaceLogo', () => {
  it('has an accessible name and can be decorative', () => {
    const { container, rerender } = render(<HuggingFaceLogo />)
    expect(screen.getByRole('img', { name: 'Hugging Face' })).toBeTruthy()
    rerender(<HuggingFaceLogo title="" />)
    expect(container.querySelector('svg')).toHaveAttribute(
      'aria-hidden',
      'true'
    )
  })
})
