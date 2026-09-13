/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'

const h = vi.hoisted(() => ({
  isOnboarding: false,
  leftPanelOpen: true,
  sidebarWidth: 260,
  setLeftPanel: vi.fn(),
  setLeftPanelWidth: vi.fn(),
  chrome: 'native' as 'native' | 'mac-overlay' | 'custom',
}))

// Tanstack router — avoid real router internals.
vi.mock('@tanstack/react-router', () => ({
  createRootRoute: (config: any) => ({ ...config, id: '__root' }),
  Outlet: () => <div data-testid="outlet" />,
  // AppLayout ends the settings search when the route leaves Settings, so it
  // reads the current path.
  useLocation: () => ({ pathname: '/' }),
  useNavigate: () => vi.fn(),
  useBlocker: () => ({
    status: 'idle',
    proceed: undefined,
    reset: undefined,
    current: undefined,
    next: undefined,
    action: undefined,
  }),
}))

// Tauri API
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    startDragging: vi.fn().mockResolvedValue(undefined),
  }),
}))

// Providers
vi.mock('@/providers/ThemeProvider', () => ({
  ThemeProvider: () => <div data-testid="theme-provider" />,
}))
vi.mock('@/providers/InterfaceProvider', () => ({
  InterfaceProvider: () => <div data-testid="interface-provider" />,
}))
vi.mock('@/providers/KeyboardShortcuts', () => ({
  KeyboardShortcutsProvider: () => <div data-testid="keyboard-provider" />,
}))
vi.mock('@/providers/DataProvider', () => ({
  DataProvider: () => <div data-testid="data-provider" />,
}))
vi.mock('@/providers/ExtensionProvider', () => ({
  ExtensionProvider: ({ children }: any) => (
    <div data-testid="extension-provider">{children}</div>
  ),
}))
vi.mock('@/providers/ToasterProvider', () => ({
  ToasterProvider: () => <div data-testid="toaster-provider" />,
}))
vi.mock('@/providers/AnalyticProvider', () => ({
  AnalyticProvider: () => <div data-testid="analytic-provider" />,
}))
vi.mock('@/providers/GlobalEventHandler', () => ({
  GlobalEventHandler: () => <div data-testid="global-event" />,
}))
vi.mock('@/providers/ServiceHubProvider', () => ({
  ServiceHubProvider: ({ children }: any) => (
    <div data-testid="service-hub">{children}</div>
  ),
}))

// i18n
vi.mock('@/i18n/TranslationContext', () => ({
  TranslationProvider: ({ children }: any) => (
    <div data-testid="translation">{children}</div>
  ),
}))

// Dialogs / containers
vi.mock('@/containers/dialogs/OutOfContextDialog', () => ({
  default: () => <div data-testid="oocp" />,
}))
vi.mock('@/containers/dialogs/AttachmentIngestionDialog', () => ({
  default: () => <div data-testid="attach-ingest" />,
}))
vi.mock('@/containers/dialogs/ErrorDialog', () => ({
  default: () => <div data-testid="error-dialog" />,
}))
vi.mock('@/containers/CommandPalette', () => ({
  CommandPalette: () => <div data-testid="command-palette-mount" />,
  useCommandPalette: { getState: () => ({ setOpen: () => {} }) },
}))
vi.mock('@/containers/GlobalError', () => ({
  default: ({ error }: any) => <div data-testid="global-error">{error?.message}</div>,
}))

// Components
vi.mock('@/components/left-sidebar', () => ({
  LeftSidebar: () => <div data-testid="left-sidebar" />,
}))
vi.mock('@/components/shell/AppRail', () => ({
  AppRail: () => <nav data-testid="app-rail" />,
}))
vi.mock('@/components/shell/StatusBar', () => ({
  StatusBar: () => <footer data-testid="status-bar" />,
}))
vi.mock('@/hooks/useAppViewport', () => ({
  useAppViewport: () => {},
}))
vi.mock('@/components/WindowControls', () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}))
vi.mock('@/components/WindowResizeGrips', () => ({
  WindowResizeGrips: () => <div data-testid="resize-grips" />,
}))
vi.mock('@/hooks/useWindowTitle', () => ({
  useWindowTitle: () => 'Jan',
}))
vi.mock('@/lib/titlebar', () => ({
  detectWindowChrome: () => h.chrome,
}))
vi.mock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: any) => (
    <div data-testid="sidebar-provider">{children}</div>
  ),
  SidebarInset: ({ children }: any) => (
    <div data-testid="sidebar-inset">{children}</div>
  ),
}))

// Hooks
vi.mock('@/hooks/useIsOnboarding', () => ({
  useIsOnboarding: () => h.isOnboarding,
}))
vi.mock('@/hooks/useLeftPanel', () => ({
  useLeftPanel: () => ({
    open: h.leftPanelOpen,
    setLeftPanel: h.setLeftPanel,
    width: h.sidebarWidth,
    setLeftPanelWidth: h.setLeftPanelWidth,
  }),
}))

vi.mock('@/constants/routes', () => ({
  route: {
    localApiServerlogs: '/local-api-server/logs',
    systemMonitor: '/system-monitor',
    appLogs: '/logs',
    threadsDetail: '/threads/$threadId',
  },
}))

import { Route } from '../__root'

const renderComponent = () => {
  const Component = Route.component as React.ComponentType
  return render(<Component />)
}

describe('__root route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.productAnalyticPrompt = false
    h.isOnboarding = false
    h.chrome = 'native'
    // reset document state
    document.body.className = ''
    const loader = document.getElementById('initial-loader')
    if (loader) loader.remove()
    // default pathname: not a logs route
    window.history.pushState({}, '', '/')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders AppLayout by default (non-logs route)', () => {
    renderComponent()
    expect(screen.getByTestId('service-hub')).toBeInTheDocument()
    expect(screen.getByTestId('theme-provider')).toBeInTheDocument()
    expect(screen.getByTestId('extension-provider')).toBeInTheDocument()
    expect(screen.getByTestId('data-provider')).toBeInTheDocument()
    expect(screen.getByTestId('left-sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('outlet')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-provider')).toBeInTheDocument()
  })

  it('renders one shell: rail, sidebar, page and status bar', () => {
    renderComponent()
    const shell = screen.getByTestId('app-shell')
    expect(shell).toContainElement(screen.getByTestId('app-rail'))
    expect(shell).toContainElement(screen.getByTestId('left-sidebar'))
    expect(shell).toContainElement(screen.getByTestId('outlet'))
    expect(shell).toContainElement(screen.getByTestId('status-bar'))
  })

  /**
   * With a native title bar (Windows) the operating system draws the caption
   * buttons and owns dragging. The layout used to draw a second set of buttons
   * and a full-width strip across the top of the page on Windows too.
   */
  it('draws no caption buttons, grips or top strip under a native title bar', () => {
    const { container } = renderComponent()
    expect(screen.queryByTestId('window-controls')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resize-grips')).not.toBeInTheDocument()
    expect(container.querySelector('[data-tauri-drag-region]')).toBeNull()
    expect(container.querySelector('.fixed.top-0.w-full')).toBeNull()
  })

  it('draws its own caption buttons and grips only for a borderless window', () => {
    h.chrome = 'custom'
    renderComponent()
    expect(screen.getByTestId('window-controls')).toBeInTheDocument()
    expect(screen.getByTestId('resize-grips')).toBeInTheDocument()
  })

  it('leaves the macOS overlay to its native traffic lights', () => {
    h.chrome = 'mac-overlay'
    renderComponent()
    expect(screen.queryByTestId('window-controls')).not.toBeInTheDocument()
  })

  it('renders all persistent dialogs', () => {
    renderComponent()
    expect(screen.getByTestId('attach-ingest')).toBeInTheDocument()
    expect(screen.getByTestId('error-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('oocp')).toBeInTheDocument()
  })


  it('uses LogsLayout on /logs path (no sidebar)', () => {
    window.history.pushState({}, '', '/logs')
    renderComponent()
    expect(screen.queryByTestId('left-sidebar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-provider')).not.toBeInTheDocument()
    expect(screen.getByTestId('outlet')).toBeInTheDocument()
  })

  it('uses LogsLayout on /system-monitor path', () => {
    window.history.pushState({}, '', '/system-monitor')
    renderComponent()
    expect(screen.queryByTestId('left-sidebar')).not.toBeInTheDocument()
    expect(screen.getByTestId('outlet')).toBeInTheDocument()
  })

  it('uses LogsLayout on /local-api-server/logs path', () => {
    window.history.pushState({}, '', '/local-api-server/logs')
    renderComponent()
    expect(screen.queryByTestId('left-sidebar')).not.toBeInTheDocument()
  })

  // Loader dismissal moved to ExtensionProvider — see ExtensionProvider.test.tsx.

  it('errorComponent renders GlobalError with provided error', () => {
    const ErrComp = (Route as any).errorComponent as React.ComponentType<{ error: Error }>
    render(<ErrComp error={new Error('broken')} />)
    expect(screen.getByTestId('global-error')).toHaveTextContent('broken')
  })
})
