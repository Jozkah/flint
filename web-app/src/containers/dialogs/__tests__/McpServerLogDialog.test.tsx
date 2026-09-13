import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import McpServerLogDialog from '../McpServerLogDialog'

const getServerLog = vi.fn()

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ mcp: () => ({ getServerLog }) }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) =>
      opts?.serverName ? `${key}:${opts.serverName}` : key,
  }),
}))

describe('McpServerLogDialog (AH-140)', () => {
  beforeEach(() => getServerLog.mockReset())

  it("shows that server's own log, asking for exactly that server", async () => {
    getServerLog.mockResolvedValue(['2026-09-13T00:00:00Z fixture ready token=[REDACTED]'])
    render(<McpServerLogDialog open onOpenChange={() => {}} serverName="fixture" />)
    await waitFor(() => expect(screen.getByText(/fixture ready/)).toBeInTheDocument())
    expect(getServerLog).toHaveBeenCalledWith('fixture', 200)
    // The log region is reachable by keyboard and named for assistive tech.
    const region = screen.getByText(/fixture ready/)
    expect(region.tagName).toBe('PRE')
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region).toHaveAttribute('aria-label', 'mcp-servers:serverLog.title:fixture')
  })

  it('says a server printed nothing rather than showing a blank box', async () => {
    getServerLog.mockResolvedValue([])
    render(<McpServerLogDialog open onOpenChange={() => {}} serverName="quiet" />)
    await waitFor(() => expect(screen.getByText('mcp-servers:serverLog.empty')).toBeInTheDocument())
  })

  it('reports a failure to read the log as an alert, and refresh asks again', async () => {
    getServerLog.mockRejectedValueOnce('no data folder').mockResolvedValueOnce(['later line'])
    render(<McpServerLogDialog open onOpenChange={() => {}} serverName="s" />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no data folder'))
    fireEvent.click(screen.getByText('mcp-servers:serverLog.refresh'))
    await waitFor(() => expect(screen.getByText('later line')).toBeInTheDocument())
    expect(getServerLog).toHaveBeenCalledTimes(2)
  })

  it('does not read anything while closed', () => {
    render(<McpServerLogDialog open={false} onOpenChange={() => {}} serverName="s" />)
    expect(getServerLog).not.toHaveBeenCalled()
  })
})
