import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

const h = vi.hoisted(() => ({
  pathname: '/threads/t1',
  navigate: vi.fn().mockResolvedValue(undefined),
  zoom: vi.fn(),
  shortcuts: vi.fn(),
  chrome: 'native' as 'native' | 'custom',
}))

vi.mock('@tanstack/react-router', () => ({
  Outlet: () => <div data-testid="outlet" />,
  useLocation: ({ select }: { select: (l: { pathname: string }) => string }) =>
    select({ pathname: h.pathname }),
  useRouter: () => ({ navigate: h.navigate, preloadRoute: vi.fn() }),
}))
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => {}),
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'chat-window-x' }),
}))
vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({}) }))
vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: {
    getState: () => ({ currentId: null, selectSession: vi.fn() }),
  },
}))
vi.mock('@/hooks/useWindowTitle', () => ({ useWindowTitle: () => 'My chat' }))
vi.mock('@/hooks/useAppViewport', () => ({ useAppViewport: () => {} }))
vi.mock('@/hooks/useMessageZoom', () => ({ useMessageZoom: h.zoom }))
vi.mock('@/hooks/useHotkeys', () => ({ useKeyboardShortcut: h.shortcuts }))
vi.mock('@/components/shell/nav-kit', () => ({
  ShellNavProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))
vi.mock('@/components/shell/HeaderSlot', () => ({
  HeaderSlotProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))
vi.mock('@/components/WindowControls', () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}))
vi.mock('@/components/WindowResizeGrips', () => ({
  WindowResizeGrips: () => <div data-testid="resize-grips" />,
}))
vi.mock('@/containers/WebPreviewHost', () => ({ WebPreviewHost: () => null }))
vi.mock('@/containers/BrowserDomainDialog', () => ({
  BrowserDomainDialog: () => null,
}))
// The providers SoloRoot wires up are not under test here.
vi.mock('@/providers/ServiceHubProvider', () => ({
  ServiceHubProvider: () => null,
}))
vi.mock('@/providers/ThemeProvider', () => ({ ThemeProvider: () => null }))
vi.mock('@/providers/InterfaceProvider', () => ({
  InterfaceProvider: () => null,
}))
vi.mock('@/providers/ToasterProvider', () => ({ ToasterProvider: () => null }))
vi.mock('@/providers/ExtensionProvider', () => ({
  ExtensionProvider: () => null,
}))
vi.mock('@/providers/DataProvider', () => ({ DataProvider: () => null }))
vi.mock('@/i18n/TranslationContext', () => ({
  TranslationProvider: () => null,
}))
vi.mock('@/hooks/useInterfaceSettings', () => ({
  useInterfaceSettings: () => false,
}))
vi.mock('@/containers/dialogs/AttachmentIngestionDialog', () => ({
  default: () => null,
}))
vi.mock('@/containers/dialogs/ErrorDialog', () => ({ default: () => null }))
vi.mock('@/containers/dialogs/OutOfContextDialog', () => ({
  default: () => null,
}))
vi.mock('@/containers/dialogs/AccessRequestDialog', () => ({
  default: () => null,
}))
vi.mock('@/containers/ModelReplaceDialog', () => ({
  ModelReplaceDialog: () => null,
}))
vi.mock('@/lib/titlebar', () => ({
  detectMacOverlay: () => false,
  detectWindowChrome: () => h.chrome,
  headerDragsWindow: () => h.chrome !== 'native',
}))

import { SoloShell } from '../SoloRoot'
import { useSoloTarget } from '@/lib/chatWindow'

describe('SoloShell', () => {
  beforeEach(() => {
    h.navigate.mockClear()
    h.shortcuts.mockClear()
    h.pathname = '/threads/t1'
    h.chrome = 'native'
    useSoloTarget.setState({ target: { kind: 'chat', refId: 't1' } })
  })

  it('shows the title and the conversation, with no sidebar or header actions', () => {
    render(<SoloShell />)
    // Native chrome: the OS title bar is the one header, the page starts
    // straight with the conversation.
    expect(screen.queryByTestId('solo-titlebar')).toBeNull()
    expect(screen.queryByTestId('solo-title')).toBeNull()
    expect(screen.getByTestId('outlet')).toBeInTheDocument()
    expect(screen.queryByTestId('context-bar')).toBeNull()
    expect(screen.queryByTestId('header-theme')).toBeNull()
    expect(screen.queryByTestId('header-activity')).toBeNull()
    expect(screen.queryByTestId('app-shell')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it('draws exactly one slim header when the window is frameless', () => {
    h.chrome = 'custom'
    render(<SoloShell />)
    expect(screen.getAllByRole('banner')).toHaveLength(1)
    expect(screen.getByTestId('solo-title')).toHaveTextContent('My chat')
    expect(screen.getByTestId('window-controls')).toBeInTheDocument()
  })

  it('registers no navigation shortcuts, only text zoom', () => {
    render(<SoloShell />)
    expect(h.shortcuts).not.toHaveBeenCalled()
    expect(h.zoom).toHaveBeenCalled()
  })

  it('sends any other page straight back to the conversation', () => {
    h.pathname = '/settings/general'
    render(<SoloShell />)
    expect(screen.queryByTestId('outlet')).toBeNull()
    expect(h.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/threads/t1', replace: true })
    )
  })

  it('keeps an unassigned spare on the idle page and renders nothing', () => {
    useSoloTarget.setState({ target: null })
    h.pathname = '/solo'
    render(<SoloShell />)
    expect(screen.queryByTestId('outlet')).toBeNull()
    expect(h.navigate).not.toHaveBeenCalled()
  })
})
