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
    expect(screen.getByText('settings:accent.current:Slate')).toBeInTheDocument()
    expect(screen.getByTestId('accent-preset-neutral')).toHaveAttribute('aria-checked', 'true')
    // The neutral default is the stylesheet's own ink: nothing is written inline.
    expect(primary()).toBe('')
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

  it('applies a custom colour and keeps white text off a very light one', () => {
    render(<AccentSettings />)
    act(() => useInterfaceSettings.getState().setAccent({ custom: '#3B6EA5' }))
    expect(primary()).toBe('#3B6EA5')
    act(() => useInterfaceSettings.getState().setAccent({ custom: '#F4F1A0' }))
    expect(document.documentElement.style.getPropertyValue('--primary-foreground')).toBe('#141210')
  })

  it('has no separate hex field: custom lives in the picker', () => {
    render(<AccentSettings />)
    expect(screen.queryByTestId('accent-hex-input')).toBeNull()
    expect(screen.getByTestId('accent-custom')).toBeInTheDocument()
  })

  it('re-derives tokens for the dark theme and resets to the neutral default', () => {
    render(<AccentSettings />)
    fireEvent.click(screen.getByTestId('accent-preset-moss'))
    act(() => {
      useTheme.setState({ isDark: true, activeTheme: 'dark' })
    })
    expect(primary()).toBe('#97B77F')
    fireEvent.click(screen.getByTestId('accent-reset'))
    expect(useInterfaceSettings.getState().accent).toEqual({ preset: 'neutral' })
    expect(primary()).toBe('')
  })
})
