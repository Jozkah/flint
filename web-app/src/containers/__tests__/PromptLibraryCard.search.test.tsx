import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { PromptLibraryCard } from '../PromptLibraryCard'
import { usePromptLibrary } from '@/lib/promptLibrary'

describe('PromptLibraryCard search', () => {
  beforeEach(() => {
    usePromptLibrary.setState({ prompts: [] })
    usePromptLibrary.getState().add({ name: 'Release notes', body: 'Write notes' })
  })

  it('shows a no-results state with a clear button when nothing matches', () => {
    render(<PromptLibraryCard />)
    const box = screen.getByRole('textbox', { name: /search/i })
    fireEvent.change(box, { target: { value: 'zzzz' } })
    const empty = screen.getByTestId('prompt-no-results')
    expect(empty).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /clear ?search/i }))
    expect(screen.queryByTestId('prompt-no-results')).toBeNull()
    expect(screen.getByText('Release notes')).toBeInTheDocument()
  })
})
