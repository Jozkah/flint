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
})
