import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { LogViewer } from '../LogViewer'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const mockReadLogs = vi.fn().mockResolvedValue([])
const mockParseLogLine = vi.fn()
const mockListen = vi.fn().mockResolvedValue(() => {})

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    app: () => ({
      readLogs: mockReadLogs,
      parseLogLine: mockParseLogLine,
    }),
    events: () => ({
      listen: mockListen,
    }),
  }),
}))

describe('LogViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadLogs.mockResolvedValue([])
  })

  it('shows noLogs message when no logs are available', async () => {
    render(<LogViewer />)

    await waitFor(() => {
      expect(screen.getByText('logs:noLogs')).toBeInTheDocument()
    })
  })

  it('calls readLogs on mount', async () => {
    render(<LogViewer />)

    await waitFor(() => {
      expect(mockReadLogs).toHaveBeenCalled()
    })
  })

  it('subscribes to live log events on mount', async () => {
    render(<LogViewer />)

    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith('log://log', expect.any(Function))
    })
  })

  it('renders log entries with timestamp, level, and message', async () => {
    mockReadLogs.mockResolvedValue([
      {
        timestamp: '2024-01-01T10:00:00Z',
        level: 'info',
        target: 'app_lib::core::server::proxy',
        message: 'Server started',
      },
    ])

    render(<LogViewer />)

    await waitFor(() => {
      expect(screen.getByText('INFO')).toBeInTheDocument()
      expect(screen.getByText('Server started')).toBeInTheDocument()
    })
  })

  it('filters logs for SERVER_LOG_TARGET only', async () => {
    mockReadLogs.mockResolvedValue([
      {
        timestamp: '2024-01-01T10:00:00Z',
        level: 'info',
        target: 'app_lib::core::server::proxy',
        message: 'Server started',
      },
      {
        timestamp: '2024-01-01T10:00:01Z',
        level: 'debug',
        target: 'some::other::target',
        message: 'Should not appear',
      },
    ])

    render(<LogViewer />)

    await waitFor(() => {
      expect(screen.getByText('Server started')).toBeInTheDocument()
    })
    expect(screen.queryByText('Should not appear')).not.toBeInTheDocument()
  })

  it('draws an error line in the destructive colour', async () => {
    mockReadLogs.mockResolvedValue([
      {
        timestamp: '2024-01-01T10:00:00Z',
        level: 'error',
        target: 'app_lib::core::server::proxy',
        message: 'Something failed',
      },
    ])

    render(<LogViewer />)

    await waitFor(() => {
      // An error line is red throughout.
      const levelEl = screen.getByText('ERROR')
      expect(levelEl.parentElement?.className).toContain('text-destructive')
    })
  })

  it('draws a warning level in the warning colour', async () => {
    mockReadLogs.mockResolvedValue([
      {
        timestamp: '2024-01-01T10:00:00Z',
        level: 'warn',
        target: 'app_lib::core::server::proxy',
        message: 'A warning',
      },
    ])

    render(<LogViewer />)

    await waitFor(() => {
      const levelEl = screen.getByText('WARN')
      expect(levelEl.className).toContain('text-warning')
    })
  })

  it('keeps an info line in the plain log colour', async () => {
    mockReadLogs.mockResolvedValue([
      {
        timestamp: '2024-01-01T10:00:00Z',
        level: 'info',
        target: 'app_lib::core::server::proxy',
        message: 'Info message',
      },
    ])

    render(<LogViewer />)

    await waitFor(() => {
      // Info keeps the log's plain colour.
      const levelEl = screen.getByText('INFO')
      expect(levelEl.parentElement?.className).not.toContain('text-destructive')
      expect(levelEl.parentElement?.className).not.toContain('text-muted-foreground')
    })
  })

  it('mutes a debug line', async () => {
    mockReadLogs.mockResolvedValue([
      {
        timestamp: '2024-01-01T10:00:00Z',
        level: 'debug',
        target: 'app_lib::core::server::proxy',
        message: 'Debug message',
      },
    ])

    render(<LogViewer />)

    await waitFor(() => {
      const levelEl = screen.getByText('DEBUG')
      expect(levelEl.parentElement?.className).toContain('text-muted-foreground')
    })
  })

  it('adds live log entries from event listener', async () => {
    mockReadLogs.mockResolvedValue([])

    let eventCallback: (event: { payload: { message: string } }) => void =
      () => {}
    mockListen.mockImplementation(
      (_event: string, cb: (event: { payload: { message: string } }) => void) => {
        eventCallback = cb
        return Promise.resolve(() => {})
      }
    )

    const parsedLog = {
      timestamp: '2024-01-01T11:00:00Z',
      level: 'info',
      target: 'app_lib::core::server::proxy',
      message: 'Live log entry',
    }
    mockParseLogLine.mockReturnValue(parsedLog)

    render(<LogViewer />)

    await waitFor(() => {
      expect(mockListen).toHaveBeenCalled()
    })

    eventCallback({ payload: { message: 'raw log line' } })

    await waitFor(() => {
      expect(screen.getByText('Live log entry')).toBeInTheDocument()
    })
  })

  it('ignores live log entries with non-matching target', async () => {
    mockReadLogs.mockResolvedValue([])

    let eventCallback: (event: { payload: { message: string } }) => void =
      () => {}
    mockListen.mockImplementation(
      (_event: string, cb: (event: { payload: { message: string } }) => void) => {
        eventCallback = cb
        return Promise.resolve(() => {})
      }
    )

    mockParseLogLine.mockReturnValue({
      timestamp: '2024-01-01T11:00:00Z',
      level: 'info',
      target: 'other::target',
      message: 'Should not show',
    })

    render(<LogViewer />)

    await waitFor(() => {
      expect(mockListen).toHaveBeenCalled()
    })

    eventCallback({ payload: { message: 'raw log line' } })

    // Should still show noLogs since the event was filtered out
    await waitFor(() => {
      expect(screen.getByText('logs:noLogs')).toBeInTheDocument()
    })
    expect(screen.queryByText('Should not show')).not.toBeInTheDocument()
  })
})
