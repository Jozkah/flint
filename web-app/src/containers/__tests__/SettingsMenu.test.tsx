import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import SettingsMenu from '../SettingsMenu'

// Mock global platform constants - simulate desktop (Tauri) environment
Object.defineProperty(global, 'IS_IOS', { value: false, writable: true })
Object.defineProperty(global, 'IS_ANDROID', { value: false, writable: true })
Object.defineProperty(global, 'IS_WEB_APP', { value: false, writable: true })

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: any) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: '/settings/general' }),
  useMatches: vi.fn(() => []),
  useNavigate: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/containers/SettingsSearch', () => ({
  SettingsSearch: () => <div data-testid="settings-search" />,
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
  getProviderTitle: (provider: string) => provider,
}))

const position = (a: Node, b: Node) =>
  a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING

describe('SettingsMenu', () => {
  it('renders the settings search above the sections', () => {
    render(<SettingsMenu />)
    expect(screen.getByTestId('settings-search')).toBeInTheDocument()
  })

  it('renders core settings links', () => {
    render(<SettingsMenu />)
    expect(screen.getByText('common:general')).toBeInTheDocument()
    expect(screen.getByText('common:appearance')).toBeInTheDocument()
    expect(screen.getByText('common:keyboardShortcuts')).toBeInTheDocument()
    expect(screen.getByText('common:assistants')).toBeInTheDocument()
  })

  it('groups pages under General, Models and tools, and Advanced, in that order', () => {
    render(<SettingsMenu />)
    const general = screen.getByText('navigation:groupGeneral')
    const tools = screen.getByText('navigation:groupModelsAndTools')
    const advanced = screen.getByText('navigation:advancedSettings')
    expect(position(general, tools)).toBeTruthy()
    expect(position(tools, advanced)).toBeTruthy()
    // Web search sits with models and tools, before the advanced group.
    const webSearch = screen.getByText('common:web_search')
    expect(position(tools, webSearch)).toBeTruthy()
    expect(position(webSearch, advanced)).toBeTruthy()
  })

  it('keeps the advanced pages visible, not behind a disclosure', () => {
    render(<SettingsMenu />)
    expect(screen.getByText('common:local_api_server')).toBeInTheDocument()
    expect(screen.getByText('common:hardware')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'navigation:advancedSettings' })
    ).toBeNull()
  })

  it('links to the Models page for providers instead of listing them', () => {
    render(<SettingsMenu />)
    const link = screen.getByText('common:modelProviders').closest('a')!
    expect(link).toHaveAttribute('href', '/settings/providers')
    expect(screen.queryByText('common:hiddenProviders')).toBeNull()
    expect(screen.queryByText('common:localProviders')).toBeNull()
  })

  it('marks selection as a raised neutral card, not the accent tint', () => {
    render(<SettingsMenu />)
    const link = screen.getByText('common:general').closest('a')!
    expect(link.className).toContain('[&.active]:bg-card')
    expect(link.className).toContain('[&.active]:border-border')
    expect(link.className).not.toContain('bg-acc-tint')
  })

  it('renders integrations links flagged as experimental', () => {
    render(<SettingsMenu />)
    expect(screen.getByText('common:mcp-servers')).toBeInTheDocument()
    expect(screen.getByText('common:claude_code')).toBeInTheDocument()
    expect(
      screen.getAllByText('common:experimental').length
    ).toBeGreaterThanOrEqual(3)
  })
})
