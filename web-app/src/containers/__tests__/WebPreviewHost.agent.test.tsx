import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

const { invoke, handlers } = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb)
    return () => handlers.delete(name)
  },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    opener: () => ({ openUrl: vi.fn() }),
    window: () => ({ createWebviewWindow: vi.fn() }),
  }),
}))
vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

import { WebPreviewHost } from '../WebPreviewHost'
import { useWebPreview } from '@/hooks/useWebPreview'
import { useBrowserAgentPane } from '@/hooks/useBrowserAgentPane'
import { toast } from 'sonner'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useBrowserAgentPrompt } from '@/hooks/useBrowserAgentPrompt'

const emit = (name: string, payload: unknown) =>
  act(() => handlers.get(name)?.({ payload }))

describe('WebPreviewHost with the assistant driving', () => {
  beforeEach(() => {
    ;(globalThis as { IS_TAURI?: boolean }).IS_TAURI = true
    invoke.mockClear()
    handlers.clear()
    useWebPreview.setState({ open: false, surface: 'side', history: [], index: -1 })
    useBrowserAgentPane.setState({ active: false, paused: false, host: null })
  })
  afterEach(() => {
    delete (globalThis as { IS_TAURI?: boolean }).IS_TAURI
  })

  it('opens the pane when the assistant asks for a page, even while closed', async () => {
    render(<WebPreviewHost />)
    await vi.waitFor(() => expect(handlers.has('browser-agent://open-pane')).toBe(true))
    emit('browser-agent://open-pane', { url: 'https://example.com/a' })
    expect(useWebPreview.getState().open).toBe(true)
    expect(useWebPreview.getState().url()).toBe('https://example.com/a')
  })

  it('does not add a history entry for the page already showing', async () => {
    useWebPreview.getState().openUrl('https://example.com/a')
    render(<WebPreviewHost />)
    await vi.waitFor(() => expect(handlers.has('browser-agent://open-pane')).toBe(true))
    emit('browser-agent://open-pane', { url: 'https://example.com/a' })
    expect(useWebPreview.getState().history).toEqual(['https://example.com/a'])
  })

  it('has no take-over button until the assistant uses the pane', async () => {
    useWebPreview.getState().openUrl('https://example.com/')
    render(<WebPreviewHost />)
    expect(screen.queryByTestId('wp-agent-toggle')).toBeNull()
    await vi.waitFor(() => expect(handlers.has('browser-agent://state')).toBe(true))
    emit('browser-agent://state', { active: true, paused: false, host: 'example.com' })
    expect(screen.getByTestId('wp-agent-toggle')).toBeTruthy()
  })

  it('take over pauses the assistant; hand back resumes it', async () => {
    useWebPreview.getState().openUrl('https://example.com/')
    render(<WebPreviewHost />)
    await vi.waitFor(() => expect(handlers.has('browser-agent://state')).toBe(true))
    emit('browser-agent://state', { active: true, paused: false, host: 'example.com' })
    fireEvent.click(screen.getByTestId('wp-agent-toggle'))
    expect(invoke).toHaveBeenCalledWith('browser_agent_stop')

    emit('browser-agent://state', { active: false, paused: true, host: null })
    expect(screen.getByTestId('wp-agent-toggle').getAttribute('aria-label')).toBe(
      'browser-agent:pane.handBack'
    )
    fireEvent.click(screen.getByTestId('wp-agent-toggle'))
    expect(invoke).toHaveBeenCalledWith('browser_agent_resume')
  })

  it('tells the user when a page was refused', async () => {
    render(<WebPreviewHost />)
    await vi.waitFor(() => expect(handlers.has('browser-agent://blocked')).toBe(true))
    emit('browser-agent://blocked', {
      url: 'http://169.254.169.254/',
      reason: 'link-local addresses are blocked',
    })
    expect(toast.warning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ description: 'http://169.254.169.254/' })
    )
  })

  it('a recreate request rebuilds the pane from scratch (a failed webview is not stuck)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      useWebPreview.getState().openUrl('https://example.com/')
      render(<WebPreviewHost />)
      await vi.waitFor(() => expect(handlers.has('browser-agent://open-pane')).toBe(true))
      const seen: boolean[] = []
      const unsub = useWebPreview.subscribe((s) => seen.push(s.open))
      emit('browser-agent://open-pane', { url: 'https://example.com/', recreate: true })
      // Closed first, so the preview drops its view (or its iframe fallback)...
      expect(useWebPreview.getState().open).toBe(false)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      // ...then opened again on the same page.
      expect(useWebPreview.getState().open).toBe(true)
      expect(useWebPreview.getState().url()).toContain('https://example.com/')
      expect(seen[0]).toBe(false)
      unsub()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a plain open request for the page already showing is left alone', async () => {
    useWebPreview.getState().openUrl('https://example.com/')
    render(<WebPreviewHost />)
    await vi.waitFor(() => expect(handlers.has('browser-agent://open-pane')).toBe(true))
    emit('browser-agent://open-pane', { url: 'https://example.com/' })
    expect(useWebPreview.getState().open).toBe(true)
    expect(useWebPreview.getState().history).toEqual(['https://example.com/'])
  })

  it('sits below the header row, so the approvals chip is never under it', () => {
    useWebPreview.getState().openUrl('https://example.com/')
    render(<WebPreviewHost />)
    const panel = screen.getByTestId('wp-side-panel')
    expect(panel.className).toContain('top-[52px]')
    expect(panel.className).not.toContain('inset-y-0')
    expect(panel.hasAttribute('data-suspended')).toBe(false)
  })

  it('steps aside, page kept, while an approval waits', async () => {
    useWebPreview.getState().openUrl('https://example.com/')
    useToolApprovalRequests.setState({ pending: {}, queued: {}, refusals: {} })
    render(<WebPreviewHost />)
    expect(screen.getByTestId('wp-side-panel').hasAttribute('data-suspended')).toBe(false)
    act(() => {
      useToolApprovalRequests.setState({
        pending: {
          c1: { requestId: 'r1', toolCallId: 'c1', toolName: 'browser_click', threadId: 't', resolve: () => {} } as never,
        },
      })
    })
    const panel = screen.getByTestId('wp-side-panel')
    expect(panel.hasAttribute('data-suspended')).toBe(true)
    expect(panel.className).toContain('invisible')
    expect(panel.className).toContain('pointer-events-none')
    // The page and its history are untouched.
    expect(useWebPreview.getState().open).toBe(true)
    expect(useWebPreview.getState().url()).toBe('https://example.com/')
    act(() => {
      useToolApprovalRequests.setState({ pending: {} })
    })
    expect(screen.getByTestId('wp-side-panel').hasAttribute('data-suspended')).toBe(false)
  })

  it('also steps aside while a site question waits', () => {
    useWebPreview.getState().openUrl('https://example.com/')
    render(<WebPreviewHost />)
    act(() => {
      useBrowserAgentPrompt.setState({
        queue: [{ id: 'd1', url: 'https://x.test/', host: 'x.test', tool: 'browser_open', resolve: () => {} }],
      })
    })
    expect(screen.getByTestId('wp-side-panel').hasAttribute('data-suspended')).toBe(true)
    act(() => {
      useBrowserAgentPrompt.setState({ queue: [] })
    })
  })

  it('a stopped redirect asks about the site, and an allow takes the pane there', async () => {
    useBrowserAgentPrompt.setState({ queue: [] })
    useWebPreview.getState().openUrl('https://example.com/')
    render(<WebPreviewHost />)
    await vi.waitFor(() => expect(handlers.has('browser-agent://domain-request')).toBe(true))
    emit('browser-agent://domain-request', {
      url: 'https://collector.test/c?d=1',
      host: 'collector.test',
    })
    await vi.waitFor(() => expect(useBrowserAgentPrompt.getState().queue).toHaveLength(1))
    const q = useBrowserAgentPrompt.getState().queue[0]
    expect(q).toMatchObject({ url: 'https://collector.test/c?d=1', host: 'collector.test' })
    await act(async () => {
      useBrowserAgentPrompt.getState().answer(q.id, { decision: 'allow', scope: 'once', subdomains: false })
    })
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('browser_agent_grant', { pattern: 'collector.test', scope: 'once' })
    )
    await vi.waitFor(() => expect(useWebPreview.getState().url()).toBe('https://collector.test/c?d=1'))
  })

  it('declining the stopped site leaves the pane where it was', async () => {
    useBrowserAgentPrompt.setState({ queue: [] })
    useWebPreview.getState().openUrl('https://example.com/')
    render(<WebPreviewHost />)
    await vi.waitFor(() => expect(handlers.has('browser-agent://domain-request')).toBe(true))
    emit('browser-agent://domain-request', { url: 'https://collector.test/', host: 'collector.test' })
    await vi.waitFor(() => expect(useBrowserAgentPrompt.getState().queue).toHaveLength(1))
    await act(async () => {
      useBrowserAgentPrompt.getState().answer(useBrowserAgentPrompt.getState().queue[0].id, {
        decision: 'deny', scope: 'once', subdomains: false,
      })
    })
    expect(useWebPreview.getState().url()).toBe('https://example.com/')
  })
})
