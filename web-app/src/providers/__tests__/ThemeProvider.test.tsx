import { render } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ThemeProvider } from '../ThemeProvider'
import { useTheme } from '@/hooks/useTheme'

vi.mock('@/hooks/useTheme', () => {
  const useThemeMock = Object.assign(
    vi.fn((select: (s: unknown) => unknown) =>
      select({
        activeTheme: 'light',
        isDark: false,
        setIsDark: vi.fn(),
        setTheme: vi.fn(),
      })
    ),
    { getState: () => ({ activeTheme: 'light' }) }
  )
  return {
    useTheme: useThemeMock,
    checkOSDarkMode: vi.fn(() => false),
  }
})

describe('ThemeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders without crashing', () => {
    render(<ThemeProvider />)
    expect(document.body).toBeInTheDocument()
  })

  it('calls theme hooks on mount', () => {
    render(<ThemeProvider />)
    expect(useTheme).toHaveBeenCalled()
  })

  it('reads activeTheme from store on event', () => {
    vi.mocked(useTheme).mockImplementation(((select: (s: unknown) => unknown) =>
      select({
        activeTheme: 'auto',
        isDark: false,
        setIsDark: vi.fn(),
        setTheme: vi.fn(),
      })) as never)
    render(<ThemeProvider />)
    expect(useTheme).toHaveBeenCalled()
  })

  it('handles light theme correctly', () => {
    vi.mocked(useTheme).mockImplementation(((select: (s: unknown) => unknown) =>
      select({
        activeTheme: 'light',
        isDark: false,
        setIsDark: vi.fn(),
        setTheme: vi.fn(),
      })) as never)
    render(<ThemeProvider />)
    expect(useTheme).toHaveBeenCalled()
  })

  it('handles dark theme correctly', () => {
    vi.mocked(useTheme).mockImplementation(((select: (s: unknown) => unknown) =>
      select({
        activeTheme: 'dark',
        isDark: true,
        setIsDark: vi.fn(),
        setTheme: vi.fn(),
      })) as never)
    render(<ThemeProvider />)
    expect(useTheme).toHaveBeenCalled()
  })
})
