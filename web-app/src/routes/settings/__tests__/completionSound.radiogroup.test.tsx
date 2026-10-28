import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { CompletionSoundSettings } from '../appearance'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'

describe('Completion sound radiogroup', () => {
  beforeEach(() => {
    useInterfaceSettings.getState().setCompletionSound('off')
  })

  it('has one tab stop and moves the selection with arrow keys, Home and End', async () => {
    const user = userEvent.setup()
    render(<CompletionSoundSettings />)
    const radios = screen.getAllByRole('radio')
    expect(radios.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1)
    await user.tab()
    expect(document.activeElement).toBe(radios[0])
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(radios[1])
    expect(useInterfaceSettings.getState().completionSound).toBe(radios[1]!.getAttribute('data-mode'))
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(radios[radios.length - 1])
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(radios[0])
    expect(useInterfaceSettings.getState().completionSound).toBe('off')
  })
})
