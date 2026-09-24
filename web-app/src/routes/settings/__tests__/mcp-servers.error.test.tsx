import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Route as McpServersRoute } from '../mcp-servers'
import { useAppState } from '@/hooks/useAppState'

const activateMCPServer = vi.fn()
const deactivateMCPServer = vi.fn()
const getConnectedServers = vi.fn().mockResolvedValue([])
const getToolsForServers = vi.fn().mockResolvedValue([])
const updateSettings = vi.fn()

vi.mock('@/containers/SettingsMenu', () => ({
  default: () => <div data-testid="settings-menu">Settings Menu</div>,
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-page">{children}</div>
  ),
}))

vi.mock('@/containers/Card', () => ({
  Card: ({ header, children }: { header?: React.ReactNode; children: React.ReactNode }) => (
    <div data-testid="card">
      {header}
      {children}
    </div>
  ),
  CardItem: ({
    title,
    description,
    descriptionOutside,
    actions,
  }: {
    title?: React.ReactNode
    description?: React.ReactNode
    descriptionOutside?: React.ReactNode
    actions?: React.ReactNode
  }) => (
    <div data-testid="card-item">
      <div>{title}</div>
      <div>{description}</div>
      <div>{descriptionOutside}</div>
      <div>{actions}</div>
    </div>
  ),
}))

vi.mock('@/containers/dialogs/AddEditMCPServer', () => ({
  default: () => null,
}))

vi.mock('@/containers/dialogs/DeleteMCPServerConfirm', () => ({
  default: () => null,
}))

vi.mock('@/containers/dialogs/EditJsonMCPserver', () => ({
  default: () => null,
}))

vi.mock('@/containers/McpRouterModelPicker', () => ({
  McpRouterModelPicker: () => null,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode
    onClick?: () => void
    'aria-label'?: string
  }) => (
    <button onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
  }: {
    checked?: boolean
    onCheckedChange?: (value: boolean) => void
    disabled?: boolean
  }) => (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={checked}
      onClick={() => onCheckedChange?.(!checked)}
    >
      toggle
    </button>
  ),
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

vi.mock('@/hooks/useServiceHub', () => {
  // One stable hub, like the real hook: a new object per render would re-run
  // every effect that depends on it and consume queued mock responses.
  const hub = {
    mcp: () => ({
      activateMCPServer,
      deactivateMCPServer,
      getConnectedServers,
      getToolsForServers,
    }),
  }
  return { useServiceHub: () => hub, getServiceHub: () => hub }
})

vi.mock('@/hooks/useToolApproval', () => ({
  useToolApproval: () => ({
    allowAllMCPPermissions: true,
    setAllowAllMCPPermissions: vi.fn(),
    isServerApproved: () => false,
    approveServer: vi.fn(),
    revokeServer: vi.fn(),
  }),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: (state: { providers: never[] }) => unknown) =>
    selector({ providers: [] }),
}))

vi.mock('@/hooks/useMCPServers', () => ({
  DEFAULT_MCP_SETTINGS: {
    toolCallTimeoutSeconds: 60,
    enableSmartToolRouting: false,
    useLightweightRouterModel: false,
    routerModelProvider: '',
    routerModelId: '',
    maxToolOutputChars: 40000,
  },
  useMCPServers: () => ({
    mcpServers: {
      NotesMCP: {
        command: 'npx',
        args: ['notes'],
        env: {},
        type: 'stdio',
        active: false,
      },
    },
    settings: {
      toolCallTimeoutSeconds: 60,
      enableSmartToolRouting: false,
      useLightweightRouterModel: false,
      routerModelProvider: '',
      routerModelId: '',
      maxToolOutputChars: 40000,
    },
    addServer: vi.fn(),
    editServer: vi.fn(),
    renameServer: vi.fn(),
    deleteServer: vi.fn(),
    syncServers: vi.fn(),
    syncServersAndRestart: vi.fn(),
    getServerConfig: () => ({
      command: 'npx',
      args: ['notes'],
      env: {},
      type: 'stdio',
      active: false,
    }),
    setSettings: vi.fn(),
    updateSettings,
  }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params?.serverKey ? `${key}:${params.serverKey}` : key,
  }),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))

vi.mock('@/types/events', () => ({
  SystemEvent: {
    MCP_UPDATE: 'mcp-update',
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (config: { component: React.ComponentType }) => config,
}))

vi.mock('@/constants/routes', () => ({
  route: {
    settings: {
      mcp_servers: '/settings/mcp-servers',
    },
  },
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

describe('MCP servers route error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppState.setState({
      errorMessage: undefined,
    })
    getConnectedServers.mockResolvedValue([])
  })

  it('stores a normalized activation error when activation rejects with an Error', async () => {
    activateMCPServer.mockRejectedValueOnce(new Error('stdio startup failed'))

    const Component = McpServersRoute.component as React.ComponentType
    render(<Component />)

    const toggles = screen.getAllByRole('button', { name: 'toggle' })
    await act(async () => {
      fireEvent.click(toggles[toggles.length - 1])
    })

    await waitFor(() => {
      expect(useAppState.getState().errorMessage).toEqual({
        message: 'stdio startup failed',
        subtitle: 'mcp-servers:checkParams',
      })
    })
  })

  it('stores a normalized activation error when activation rejects with an object payload', async () => {
    activateMCPServer.mockRejectedValueOnce({ message: 'wrapped startup failed' })

    const Component = McpServersRoute.component as React.ComponentType
    render(<Component />)

    const toggles = screen.getAllByRole('button', { name: 'toggle' })
    await act(async () => {
      fireEvent.click(toggles[toggles.length - 1])
    })

    await waitFor(() => {
      expect(useAppState.getState().errorMessage?.message).toBe('wrapped startup failed')
    })
  })
})

// Connection state on the row. Mock-backed: activate/getConnectedServers are
// vi.fn()s, no real MCP server is started.
describe('MCP server connection state on the row', () => {
  const serverToggle = () => {
    const toggles = screen.getAllByRole('button', { name: 'toggle' })
    return toggles[toggles.length - 1]
  }
  const status = () => screen.getByTestId('mcp-status-NotesMCP')
  // Server cards render collapsed by default (00587f226); the connection
  // status and details live in the expanded body.
  const expandCard = () =>
    fireEvent.click(
      screen.getByRole('button', { name: 'mcp-servers:expandServer' })
    )

  beforeEach(() => {
    vi.clearAllMocks()
    useAppState.setState({ errorMessage: undefined })
    getConnectedServers.mockResolvedValue([])
    getToolsForServers.mockResolvedValue([])
    deactivateMCPServer.mockResolvedValue(undefined)
  })

  it('reverts the switch and shows the failure inline with a next step', async () => {
    activateMCPServer.mockRejectedValueOnce(new Error('spawn npx ENOENT'))
    const Component = McpServersRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })
    expandCard()

    await act(async () => {
      fireEvent.click(serverToggle())
    })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('spawn npx ENOENT')
    expect(alert).toHaveTextContent('mcp-servers:connection.nextStep.checkCommand')
    expect(status()).toHaveTextContent('mcp-servers:connection.state.failed')
    expect(serverToggle()).toHaveAttribute('aria-pressed', 'false')
    const { toast } = await import('sonner')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('shows connecting until the re-query lists the server, then connected', async () => {
    let resolveConnected: (names: string[]) => void = () => {}
    activateMCPServer.mockResolvedValueOnce(undefined)
    const Component = McpServersRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })
    expandCard()
    expect(status()).toHaveTextContent('mcp-servers:connection.state.disabled')

    getConnectedServers.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveConnected = resolve
        })
    )
    getToolsForServers.mockResolvedValue([
      { name: 'search_notes', server: 'NotesMCP' },
    ])

    await act(async () => {
      fireEvent.click(serverToggle())
    })

    // Activation has resolved but the backend has not confirmed yet.
    expect(activateMCPServer).toHaveBeenCalledTimes(1)
    expect(status()).toHaveTextContent('mcp-servers:connection.state.connecting')
    expect(serverToggle()).toHaveAttribute('aria-pressed', 'true')
    const { toast } = await import('sonner')
    expect(toast.success).not.toHaveBeenCalled()

    getConnectedServers.mockResolvedValue(['NotesMCP'])
    await act(async () => {
      resolveConnected(['NotesMCP'])
    })

    await waitFor(() =>
      expect(status()).toHaveTextContent('mcp-servers:connection.state.connected')
    )
    expect(toast.success).toHaveBeenCalledWith(
      'mcp-servers:serverStatusActive:NotesMCP'
    )
    await waitFor(() =>
      expect(
        screen.getByText('mcp-servers:connection.toolsAvailable')
      ).toBeInTheDocument()
    )
    expect(getToolsForServers).toHaveBeenCalledWith(['NotesMCP'])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('treats a start that never appears as connected as a failure and stops it', async () => {
    activateMCPServer.mockResolvedValueOnce(undefined)
    getConnectedServers.mockResolvedValue([])
    const Component = McpServersRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })
    expandCard()

    await act(async () => {
      fireEvent.click(serverToggle())
    })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('mcp-servers:connection.notListedAfterStart')
    expect(status()).toHaveTextContent('mcp-servers:connection.state.failed')
    await waitFor(() =>
      expect(deactivateMCPServer).toHaveBeenCalledWith('NotesMCP')
    )
  })

  it('offers an expandable explanation with where it runs and what delete keeps', async () => {
    const Component = McpServersRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })
    expandCard()
    const summary = screen.getByText('mcp-servers:details.toggle')
    expect(summary.tagName).toBe('SUMMARY')
    expect(
      screen.getByText('mcp-servers:details.runsWhereLocalProcess')
    ).toBeInTheDocument()
    expect(
      screen.getByText('mcp-servers:details.externalDepends')
    ).toBeInTheDocument()
    expect(
      screen.getByText('mcp-servers:details.effectRemove')
    ).toBeInTheDocument()
  })
})

// #8557: users had no way to bound an MCP result before it filled the context.
describe('max tool output characters control', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConnectedServers.mockResolvedValue([])
  })

  const capInput = (): HTMLInputElement => {
    const inputs = screen.getAllByRole<HTMLInputElement>('spinbutton')
    const found = inputs.find((i) => i.value === '40000')
    if (!found) throw new Error('cap input not rendered')
    return found
  }

  it('shows the configured cap and saves an edited one', async () => {
    const Component = McpServersRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    fireEvent.change(capInput(), { target: { value: '12000' } })

    expect(updateSettings).toHaveBeenCalledWith({ maxToolOutputChars: 12000 })
  })

  it('accepts 0 as an explicit opt-out rather than rejecting it', async () => {
    const Component = McpServersRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    fireEvent.change(capInput(), { target: { value: '0' } })

    expect(updateSettings).toHaveBeenCalledWith({ maxToolOutputChars: 0 })
  })

  it('restores the default when the field is cleared', async () => {
    // An empty box must not persist as "0 characters of tool output".
    const Component = McpServersRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    fireEvent.change(capInput(), { target: { value: '' } })

    expect(updateSettings).toHaveBeenCalledWith({ maxToolOutputChars: 40000 })
  })
})
