import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Route as GeneralRoute } from '../general'

const mockGetUnavailableJanDataFolder = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
)

// Mock all the dependencies
const platform = vi.hoisted(() => ({ tauri: true }))
vi.mock('@/lib/platform/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/utils')>()),
  isPlatformTauri: () => platform.tauri,
}))

vi.mock('@/containers/SettingsMenu', () => ({
  default: () => <div data-testid="settings-menu">Settings Menu</div>,
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-page">{children}</div>
  ),
}))

vi.mock('@/containers/Card', () => ({
  Card: ({
    title,
    children,
  }: {
    title?: string
    children: React.ReactNode
  }) => (
    <div data-testid="card" data-title={title}>
      {title && <div data-testid="card-title">{title}</div>}
      {children}
    </div>
  ),
  CardItem: ({
    title,
    description,
    actions,
    className,
  }: {
    title?: string
    description?: string
    actions?: React.ReactNode
    className?: string
  }) => (
    <div data-testid="card-item" data-title={title} className={className}>
      {title && <div data-testid="card-item-title">{title}</div>}
      {description && (
        <div data-testid="card-item-description">{description}</div>
      )}
      {actions && <div data-testid="card-item-actions">{actions}</div>}
    </div>
  ),
}))

vi.mock('@/containers/LanguageSwitcher', () => ({
  default: () => <div data-testid="language-switcher">Language Switcher</div>,
}))

const dataFolderMocks = vi.hoisted(() => ({
  open: vi.fn(),
  stopAllModels: vi.fn(),
  emit: vi.fn(),
}))

vi.mock('@/containers/dialogs/ChangeDataFolderLocation', () => ({
  default: ({
    children,
    open,
    onConfirm,
  }: {
    children: React.ReactNode
    open?: boolean
    onConfirm?: () => void
  }) => (
    <div data-testid="change-data-folder-dialog">
      {children}
      {open && (
        <button data-testid="confirm-data-folder-change" onClick={onConfirm}>
          confirm
        </button>
      )}
    </div>
  ),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: () => ({
    spellCheckChatInput: true,
    setSpellCheckChatInput: vi.fn(),
    huggingfaceToken: 'test-token',
    setHuggingfaceToken: vi.fn(),
    setAutoUpdateCheck: vi.fn(),
  }),
}))

// The picker reads the fallback list through a selector this flat mock ignores.
vi.mock('@/containers/FallbackModelsPicker', () => ({ default: () => null }))

// Create a controllable mock
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
  }) => (
    <input
      data-testid="switch"
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    [key: string]: any
  }) => (
    <button
      data-testid="button"
      onClick={onClick}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  ),
}))

vi.mock('@/components/ui/input', () => ({
  Input: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
    placeholder?: string
  }) => (
    <input
      data-testid="input"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  ),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog">{children}</div>
  ),
  DialogClose: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-close">{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-description">{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-header">{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-title">{children}</div>
  ),
  DialogTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-trigger">{children}</div>
  ),
}))

vi.mock('@/services/app/web', () => ({
  WebAppService: vi.fn().mockImplementation(() => ({
    factoryReset: vi.fn(),
    getJanDataFolder: vi.fn().mockResolvedValue('/test/data/folder'),
    relocateJanDataFolder: vi.fn(),
  })),
}))

vi.mock('@/services/models/default', () => ({
  DefaultModelsService: vi.fn().mockImplementation(() => ({
    stopAllModels: vi.fn(),
  })),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    app: () => ({
      factoryReset: vi.fn(),
      getJanDataFolder: vi.fn().mockResolvedValue('/test/data/folder'),
      getUnavailableJanDataFolder: mockGetUnavailableJanDataFolder,
      relocateJanDataFolder: vi.fn(),
    }),
    models: () => ({
      stopAllModels: dataFolderMocks.stopAllModels,
    }),
    dialog: () => ({
      open: dataFolderMocks.open,
    }),
    events: () => ({
      emit: dataFolderMocks.emit,
    }),
    window: () => ({
      openLogsWindow: vi.fn(),
    }),
    opener: () => ({
      revealItemInDir: vi.fn(),
      openPath: vi.fn(),
    }),
    path: () => ({
      join: vi.fn().mockResolvedValue('/test/data/folder/logs'),
      sep: vi.fn().mockReturnValue('/'),
      dirname: vi.fn().mockResolvedValue('/test/data/folder'),
      basename: vi.fn().mockResolvedValue('logs'),
      extname: vi.fn().mockResolvedValue(''),
    }),
  }),
}))

// Add tests for rfd dialog
// vi.mock('@tauri-apps/plugin-dialog', () => ({
//   open: vi.fn(),
// }))

vi.mock('@/containers/StartupItems', () => ({ StartupItems: () => null }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ installed: false, path: null }),
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: vi.fn(),
  openPath: vi.fn(),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => {
  const MockWebviewWindow = vi
    .fn()
    .mockImplementation((label: string, options: any) => ({
      once: vi.fn(),
      setFocus: vi.fn(),
    }))
  MockWebviewWindow.getByLabel = vi.fn().mockReturnValue(null)

  return {
    WebviewWindow: MockWebviewWindow,
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/lib/utils', () => ({
  isDev: vi.fn().mockReturnValue(false),
  // The page renders SettingTarget, which merges classes with `cn`. Mocking
  // the module without it makes the whole page fail to render.
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/constants/routes', () => ({
  route: {
    settings: {
      general: '/settings/general',
    },
    appLogs: '/logs',
  },
}))

vi.mock('@/constants/windows', () => ({
  windowKey: {
    logsAppWindow: 'logs-app-window',
  },
}))

vi.mock('@/types/events', () => ({
  SystemEvent: {
    KILL_SIDECAR: 'kill-sidecar',
  },
}))


vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  createFileRoute: (path: string) => (config: any) => ({
    ...config,
    component: config.component,
  }),
}))

// Mock global variables
global.VERSION = '1.0.0'
global.IS_MACOS = false
global.IS_WINDOWS = true
global.AUTO_UPDATER_DISABLED = false
global.window = {
  ...global.window,
  core: {
    api: {
      relaunch: vi.fn(),
      getConnectedServers: vi.fn().mockResolvedValue([]),
    },
  },
}

// Mock navigator clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn(),
  },
})

describe('General Settings Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUnavailableJanDataFolder.mockResolvedValue(undefined)
    dataFolderMocks.open.mockResolvedValue('/test/path')
  })

  it('should render the general settings page', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-menu')).toBeNull()
    expect(screen.getByText('common:settings')).toBeInTheDocument()
  })

  it('has no Credits card', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const titles = screen
      .getAllByTestId('card')
      .map((c) => c.getAttribute('data-title'))
    expect(titles).not.toContain('settings:general.credits')
  })

  it('should render app version', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
  })

  it('offers no link that leaves the device', async () => {
    // The docs, releases, repository, chat and issue-tracker rows are gone.
    // This page is where they were, so it is where a new one would reappear.
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const external = screen
      .queryAllByRole('link')
      .map((link) => link.getAttribute('href') ?? '')
      .filter((href) => /^https?:/i.test(href))
    expect(external).toEqual([])
  })

  it('keeps only the app, startup and command line groups', async () => {
    global.IS_TAURI = true
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })
    const titles = screen
      .getAllByTestId('card')
      .map((c) => c.getAttribute('data-title'))
    expect(titles).toContain('common:general')
    expect(titles).toContain('settings:general.cliGroup')
    expect(titles).not.toContain('common:dataFolder')
    expect(titles).not.toContain('settings:general.advanced')
    expect(titles).not.toContain('common:others')
    expect(screen.queryByText('settings:general.replyLanguage')).toBeNull()
    expect(screen.queryByText('settings:general.huggingfaceToken')).toBeNull()
    expect(screen.queryByText('settings:others.resetFactory')).toBeNull()
    expect(screen.queryByText('settings:others.spellCheck')).toBeNull()
    global.IS_TAURI = false
  })
})
