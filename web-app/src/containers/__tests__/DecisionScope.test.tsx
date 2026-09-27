import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { DecisionScope } from '../DecisionScope'

const LONG =
  'gh pr create --title "fix: cache" --body "a-very-long-unbroken-token-' +
  'x'.repeat(300) +
  '"'

describe('DecisionScope', () => {
  it('shows a long scope on one clipped line with the full value on hover', () => {
    render(<DecisionScope resource={LONG} reason="Once" />)
    const value = screen.getByTestId('decision-scope-value')
    expect(value).toHaveClass('truncate')
    expect(value.className).not.toContain('overflow-wrap:anywhere')
    expect(value).toHaveAttribute('title', LONG)
    expect(screen.getByText('Once')).toBeInTheDocument()
  })

  it('expands to the full value, wrapping anywhere only when expanded', () => {
    render(<DecisionScope resource={LONG} />)
    const toggle = screen.getByTestId('decision-scope-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    const value = screen.getByTestId('decision-scope-value')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(value).not.toHaveClass('truncate')
    expect(value.className).toContain('[overflow-wrap:anywhere]')
    expect(value).toHaveTextContent(LONG)
    fireEvent.click(toggle)
    expect(screen.getByTestId('decision-scope-value')).toHaveClass('truncate')
  })

  it('copies the full value', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<DecisionScope resource={LONG} />)
    fireEvent.click(screen.getByLabelText('common:decisionScopeCopy'))
    expect(writeText).toHaveBeenCalledWith(LONG)
  })

  it('shows only the reason when there is no resource', () => {
    render(<DecisionScope reason="Conversation" />)
    expect(screen.getByText('Conversation')).toBeInTheDocument()
    expect(screen.queryByTestId('decision-scope-toggle')).not.toBeInTheDocument()
  })
})
