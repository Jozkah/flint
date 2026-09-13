import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { AccentSettings } from '../AccentSettings'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useTheme } from '@/hooks/useTheme'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) =>
      opts?.value ? `${key}:${opts.value}` : opts?.name ? `${key}:${opts.name}` : key,
  }),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ theme: () => ({ setTheme: vi.fn() }) }),
}))

const primary = () =>
  document.documentElement.style.getPropertyValue('--primary')

describe('AccentSettings', () => {
  beforeEach(() => {
    act(() => {
      useTheme.setState({ isDark: false, activeTheme: 'light' })
      useInterfaceSettings.getState().resetAccent()
    })
  })

  it('shows the current accent and marks the selected preset', () => {
    render(<AccentSettings />)
    expect(screen.getByText('settings:accent.current:Vermilion')).toBeInTheDocument()
    expect(screen.getByTestId('accent-preset-vermilion')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('accent-reset')).toBeDisabled()
  })

  it('applies a preset immediately and enables reset', () => {
    render(<AccentSettings />)
    fireEvent.click(screen.getByTestId('accent-preset-moss'))
    expect(useInterfaceSettings.getState().accent).toEqual({ preset: 'moss' })
    expect(primary()).toBe('#4E6E3A')
    expect(screen.getByTestId('accent-preset-moss')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('accent-reset')).not.toBeDisabled()
  })

  it('applies a valid hex as it is typed', () => {
    render(<AccentSettings />)
    fireEvent.change(screen.getByTestId('accent-hex-input'), { target: { value: '#3b6ea5' } })
    expect(useInterfaceSettings.getState().accent).toEqual({ custom: '#3B6EA5' })
    expect(primary()).toBe('#3B6EA5')
    expect(screen.getByRole('status')).toHaveTextContent('settings:accent.hexApplied')
  })

  it('rejects invalid hex clearly and keeps the current accent', () => {
    render(<AccentSettings />)
    fireEvent.click(screen.getByTestId('accent-preset-ink'))
    const input = screen.getByTestId('accent-hex-input')

    fireEvent.change(input, { target: { value: '#12G4' } })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(
      'settings:accent.hexInvalidCharacters:#12G4'
    )

    fireEvent.change(input, { target: { value: '#12AB' } })
    fireEvent.blur(input)
    expect(screen.getByRole('status')).toHaveTextContent('settings:accent.hexInvalid:#12AB')
    expect(useInterfaceSettings.getState().accent).toEqual({ preset: 'ink' })
  })

  it('never uses white text on a very light custom accent', () => {
    render(<AccentSettings />)
    fireEvent.change(screen.getByTestId('accent-hex-input'), { target: { value: '#F4F1A0' } })
    expect(document.documentElement.style.getPropertyValue('--primary-foreground')).toBe('#141210')
  })

  it('re-derives tokens for the dark theme and resets to Vermilion', () => {
    render(<AccentSettings />)
    fireEvent.click(screen.getByTestId('accent-preset-moss'))
    act(() => {
      useTheme.setState({ isDark: true, activeTheme: 'dark' })
    })
    expect(primary()).toBe('#97B77F')
    fireEvent.click(screen.getByTestId('accent-reset'))
    expect(useInterfaceSettings.getState().accent).toEqual({ preset: 'vermilion' })
    expect(primary()).toBe('#E0654D')
  })
})
