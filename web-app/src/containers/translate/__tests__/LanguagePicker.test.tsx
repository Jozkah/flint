import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { LanguagePicker } from '../LanguagePicker'

describe('LanguagePicker', () => {
  it('filters by typing and picks with Enter', () => {
    const onChange = vi.fn()
    render(
      <LanguagePicker value="English" onChange={onChange} data-testid="p" />
    )
    fireEvent.click(screen.getByTestId('p'))
    fireEvent.change(screen.getByTestId('translate-language-search'), {
      target: { value: 'cata' },
    })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(screen.getByTestId('translate-language-search'), {
      key: 'Enter',
    })
    expect(onChange).toHaveBeenCalledWith('Catalan')
  })

  it('points aria-activedescendant at the highlighted option', () => {
    render(<LanguagePicker value="English" onChange={() => {}} data-testid="p" />)
    fireEvent.click(screen.getByTestId('p'))
    const input = screen.getByTestId('translate-language-search')
    const options = screen.getAllByRole('option')
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id)
    expect(options[1].id).not.toBe('')
  })

  it('offers detect only on the source side', () => {
    render(
      <LanguagePicker
        value="auto"
        onChange={() => {}}
        allowAuto
        data-testid="p"
      />
    )
    fireEvent.click(screen.getByTestId('p'))
    expect(screen.getAllByRole('option')[0]).toHaveAttribute(
      'data-value',
      'auto'
    )
  })
})
