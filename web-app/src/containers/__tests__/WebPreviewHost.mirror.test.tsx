import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    opener: () => ({ openUrl: vi.fn() }),
    window: () => ({ createWebviewWindow: vi.fn() }),
  }),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, v?: Record<string, string>) => (v?.action ? `${k}:${v.action}` : k),
  }),
}))

import { WebPreviewHost } from '../WebPreviewHost'
import { useWebPreview } from '@/hooks/useWebPreview'
import { useThreads } from '@/hooks/useThreads'
import { useBrowserToolMirror } from '@/hooks/useBrowserToolMirror'

const shot = 'data:image/jpeg;base64,AAAA'

const notice = (over: Record<string, unknown> = {}) => ({
  sessionId: 'thread-1',
  runId: 'thread-1',
  kind: 'action',
  action: 'click e12 button "Save"',
  url: 'http://127.0.0.1:5173/form',
  title: 'Form',
  screenshot: shot,
  ...over,
})

describe('WebPreviewHost: the agent browser mirror in the chat', () => {
  beforeEach(() => {
    useWebPreview.setState({ open: false, surface: 'side', history: [], index: -1 })
    useBrowserToolMirror.setState({
      byId: {},
      attach: vi.fn().mockResolvedValue(() => undefined),
      watch: vi.fn().mockReturnValue(() => undefined),
    })
    useThreads.setState({ currentThreadId: 'thread-1' } as never)
  })

  it('renders nothing while the agent has not used its browser', () => {
    const { container } = render(<WebPreviewHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the address, title, action and picture in a panel when the preview is closed', () => {
    render(<WebPreviewHost />)
    act(() => useBrowserToolMirror.getState().apply(notice()))
    expect(screen.getByTestId('wp-mirror-panel')).toBeTruthy()
    expect(screen.getByTestId('btm-url').textContent).toBe('http://127.0.0.1:5173/form')
    expect(screen.getByTestId('btm-title').textContent).toBe('Form')
    expect(screen.getByTestId('btm-action').textContent).toContain('click e12')
    expect((screen.getByTestId('btm-screenshot') as HTMLImageElement).getAttribute('src')).toBe(shot)
    // Read-only: an image only, never the page itself in a frame or webview.
    expect(document.querySelector('iframe, webview, object, embed')).toBeNull()
  })

  it('shows only the conversation in view', () => {
    render(<WebPreviewHost />)
    act(() => useBrowserToolMirror.getState().apply(notice({ sessionId: 'thread-2' })))
    expect(screen.queryByTestId('wp-mirror-panel')).toBeNull()
  })

  it('clears when the browser closes or the panel is dismissed', () => {
    render(<WebPreviewHost />)
    act(() => useBrowserToolMirror.getState().apply(notice()))
    expect(screen.getByTestId('wp-mirror-panel')).toBeTruthy()
    act(() => useBrowserToolMirror.getState().apply(notice({ kind: 'closed', screenshot: null })))
    expect(screen.queryByTestId('wp-mirror-panel')).toBeNull()
  })

  it('sits above the page, not instead of it, when the preview is open', () => {
    useWebPreview.getState().openUrl('https://a.com')
    render(<WebPreviewHost />)
    act(() => useBrowserToolMirror.getState().apply(notice()))
    expect(screen.getByTestId('browser-tool-mirror')).toBeTruthy()
    // The preview's own page is still the preview's: the agent's address is never loaded in it.
    const frame = screen.getByTitle('https://a.com') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe('https://a.com')
    expect(document.querySelectorAll('iframe')).toHaveLength(1)
  })

  it('listens, and asks for pictures only while it shows the browser', () => {
    const attach = vi.fn().mockResolvedValue(() => undefined)
    const watch = vi.fn().mockReturnValue(() => undefined)
    useBrowserToolMirror.setState({ attach, watch })
    render(<WebPreviewHost />)
    expect(attach).toHaveBeenCalled()
    expect(watch).not.toHaveBeenCalled()
    act(() => useBrowserToolMirror.getState().apply(notice()))
    expect(watch).toHaveBeenCalled()
  })
})
