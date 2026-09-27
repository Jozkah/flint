import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { useWebPreview } from '@/hooks/useWebPreview'

const { invoke, listeners, openUrl } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  openUrl: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(name, cb)
    return () => listeners.delete(name)
  }),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    opener: () => ({ openUrl }),
    window: () => ({ createWebviewWindow: vi.fn() }),
  }),
}))

import { WebPreviewHost } from '../WebPreviewHost'

const emit = (payload: unknown) =>
  act(() => listeners.get('web-preview://navigated')?.({ payload }))
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd)

describe('WebPreviewHost (native child webview)', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_TAURI', { value: true, writable: true, configurable: true })
    invoke.mockReset().mockResolvedValue(undefined)
    listeners.clear()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 10, top: 20, width: 300, height: 400, right: 310, bottom: 420, x: 10, y: 20,
      toJSON: () => ({}),
    } as DOMRect)
    useWebPreview.setState({ open: false, surface: 'side', history: [], index: -1 })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(globalThis, 'IS_TAURI', { value: false, writable: true, configurable: true })
  })

  it('creates a native view instead of an iframe and hides the blocked banner', async () => {
    useWebPreview.getState().openUrl('https://github.com/')
    render(<WebPreviewHost />)
    await waitFor(() => expect(calls('web_preview_create')).toHaveLength(1))
    expect(calls('web_preview_create')[0][1]).toMatchObject({
      id: 'rail',
      url: 'https://github.com/',
    })
    expect(screen.queryByTitle('https://github.com/')).toBeNull()
    expect(screen.getByTestId('wp-native-viewport')).toBeInTheDocument()
  })

  it('falls back to the iframe with the banner when creation fails', async () => {
    invoke.mockRejectedValueOnce(new Error('no multiwebview'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useWebPreview.getState().openUrl('https://a.com/')
    render(<WebPreviewHost />)
    await waitFor(() => expect(screen.getByTitle('https://a.com/')).toBeInTheDocument())
    expect(screen.queryByTestId('wp-native-viewport')).toBeNull()
    warn.mockRestore()
  })

  it('page loads in the native view update the address bar history', async () => {
    useWebPreview.getState().openUrl('https://github.com/')
    render(<WebPreviewHost />)
    await waitFor(() => expect(listeners.has('web-preview://navigated')).toBe(true))
    // Own initial load finishes.
    emit({ id: 'rail', url: 'https://github.com/', loading: false })
    // User clicks a link inside the page.
    emit({ id: 'rail', url: 'https://github.com/jozkah', loading: true })
    expect(useWebPreview.getState().url()).toBe('https://github.com/jozkah')
    expect(useWebPreview.getState().history).toHaveLength(2)
    // Redirect lands on the final URL: replaces rather than pushes.
    emit({ id: 'rail', url: 'https://github.com/Jozkah', loading: false })
    expect(useWebPreview.getState().history).toEqual([
      'https://github.com/',
      'https://github.com/Jozkah',
    ])
    // Events from the native view never echo back as a navigate command.
    expect(calls('web_preview_navigate')).toHaveLength(0)
    // Ignores other ids.
    emit({ id: 'other', url: 'https://evil.test/', loading: true })
    expect(useWebPreview.getState().url()).toBe('https://github.com/Jozkah')
  })

  it('toolbar back and reload drive the native view', async () => {
    useWebPreview.getState().openUrl('https://a.com/')
    useWebPreview.getState().navigate('https://b.com/')
    render(<WebPreviewHost />)
    await waitFor(() => expect(listeners.has('web-preview://navigated')).toBe(true))
    fireEvent.click(screen.getByLabelText(/back/i))
    await waitFor(() =>
      expect(calls('web_preview_navigate').at(-1)?.[1]).toEqual({ id: 'rail', url: 'https://a.com/' })
    )
    fireEvent.click(screen.getByLabelText(/reload/i))
    await waitFor(() => expect(calls('web_preview_reload')).toHaveLength(1))
  })

  it('hides the native view while a dialog is open and closes it on close', async () => {
    useWebPreview.getState().openUrl('https://a.com/')
    const { unmount } = render(<WebPreviewHost />)
    await waitFor(() => expect(listeners.has('web-preview://navigated')).toBe(true))
    await waitFor(() => expect(calls('web_preview_create')).toHaveLength(1))
    expect(calls('web_preview_hide')).toHaveLength(0)
    const dlg = document.createElement('div')
    dlg.setAttribute('role', 'dialog')
    dlg.setAttribute('data-state', 'open')
    await act(async () => {
      document.body.appendChild(dlg)
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(calls('web_preview_hide').length).toBeGreaterThan(0)
    dlg.remove()
    act(() => useWebPreview.getState().close())
    await waitFor(() => expect(calls('web_preview_close')).toHaveLength(1))
    unmount()
  })
})
