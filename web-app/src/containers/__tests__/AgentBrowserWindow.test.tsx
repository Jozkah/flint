import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, v?: Record<string, string>) => (v?.action ? `${k}:${v.action}` : k),
  }),
}))

import { AgentBrowserWindow } from '../AgentBrowserWindow'
import { CoworkRailToolbar } from '../CoworkRailToolbar'
import { useBrowserToolMirror } from '@/hooks/useBrowserToolMirror'

const shot = 'data:image/jpeg;base64,AAAA'
const frame2 = 'data:image/jpeg;base64,BBBB'

const notice = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  runId: 'r1',
  kind: 'action',
  action: 'click e12 button "Save"',
  url: 'http://127.0.0.1:5173/form',
  title: 'Form',
  screenshot: shot,
  ...over,
})

describe('AgentBrowserWindow', () => {
  let attach: ReturnType<typeof vi.fn>
  let watch: ReturnType<typeof vi.fn>
  let release: ReturnType<typeof vi.fn>
  beforeEach(() => {
    release = vi.fn()
    attach = vi.fn().mockResolvedValue(() => undefined)
    watch = vi.fn().mockReturnValue(release)
    useBrowserToolMirror.setState({ byId: {}, attach, watch } as never)
  })

  it('renders nothing until the agent has used its browser, and asks for nothing', () => {
    const { container } = render(<AgentBrowserWindow sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
    expect(attach).toHaveBeenCalled()
    expect(watch).not.toHaveBeenCalled()
  })

  it('looks like the preview: an address row with navigation chrome, a viewport and the facts', () => {
    render(<AgentBrowserWindow sessionId="s1" />)
    act(() => useBrowserToolMirror.getState().apply(notice()))
    expect(screen.getByTestId('abw-url').textContent).toBe('http://127.0.0.1:5173/form')
    expect(screen.getByTestId('abw-title').textContent).toBe('Form')
    expect(screen.getByTestId('abw-action').textContent).toContain('click e12')
    // Back, forward and reload are there, and inert: this is a view, not a browser.
    for (const name of ['back', 'forward', 'reload']) {
      const b = screen.getByLabelText(`common:webPreview.${name}`) as HTMLButtonElement
      expect(b.disabled).toBe(true)
    }
    const img = screen.getByTestId('abw-frame') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(shot)
    expect(screen.getByTestId('abw-viewport').contains(img)).toBe(true)
    // Read-only and not the page: only an image, no frame, webview or input.
    expect(document.querySelector('iframe, webview, object, embed, input, textarea')).toBeNull()
    expect(screen.getByTestId('abw-live').getAttribute('data-live')).toBe('true')
  })

  it('asks the backend for the live view only while it shows the browser', () => {
    const { unmount } = render(<AgentBrowserWindow sessionId="s1" />)
    expect(watch).not.toHaveBeenCalled()
    act(() => useBrowserToolMirror.getState().apply(notice()))
    expect(watch).toHaveBeenCalledTimes(1)
    unmount()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('updates the picture as frames arrive without touching the facts', () => {
    render(<AgentBrowserWindow sessionId="s1" />)
    act(() => useBrowserToolMirror.getState().apply(notice()))
    act(() =>
      useBrowserToolMirror.getState().apply(notice({ kind: 'frame', action: '', url: '', title: '', screenshot: frame2 }))
    )
    expect((screen.getByTestId('abw-frame') as HTMLImageElement).getAttribute('src')).toBe(frame2)
    expect(screen.getByTestId('abw-url').textContent).toBe('http://127.0.0.1:5173/form')
    expect(screen.getByTestId('abw-action').textContent).toContain('click e12')
  })

  it('shows the tabs when there is more than one, the active one marked', () => {
    render(<AgentBrowserWindow sessionId="s1" />)
    act(() =>
      useBrowserToolMirror.getState().apply(
        notice({ tabs: [{ id: 't1', title: 'Shop', active: false }, { id: 't2', title: 'Upload page', active: true }] })
      )
    )
    const tabs = screen.getByTestId('abw-tabs')
    expect(tabs.textContent).toContain('Shop')
    expect(tabs.querySelector('[aria-selected=true]')?.textContent).toBe('Upload page')
  })

  it('reads idle once nothing has happened for a while, and live again on a frame', () => {
    vi.useFakeTimers()
    try {
      render(<AgentBrowserWindow sessionId="s1" />)
      act(() => useBrowserToolMirror.getState().apply(notice()))
      expect(screen.getByTestId('abw-live').getAttribute('data-live')).toBe('true')
      act(() => vi.advanceTimersByTime(8000))
      expect(screen.getByTestId('abw-live').getAttribute('data-live')).toBe('false')
      act(() =>
        useBrowserToolMirror.getState().apply(notice({ kind: 'frame', screenshot: frame2 }), Date.now())
      )
      act(() => vi.advanceTimersByTime(1000))
      expect(screen.getByTestId('abw-live').getAttribute('data-live')).toBe('true')
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides on request and goes when the browser closes', async () => {
    const onHide = vi.fn(() => useBrowserToolMirror.getState().clear('s1'))
    render(<AgentBrowserWindow sessionId="s1" onHide={onHide} />)
    act(() => useBrowserToolMirror.getState().apply(notice()))
    fireEvent.click(screen.getByTestId('abw-hide'))
    expect(onHide).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('agent-browser-window')).toBeNull())
    act(() => useBrowserToolMirror.getState().apply(notice()))
    expect(screen.getByTestId('agent-browser-window')).toBeTruthy()
    act(() => useBrowserToolMirror.getState().apply(notice({ kind: 'closed', screenshot: null })))
    expect(screen.queryByTestId('agent-browser-window')).toBeNull()
  })

  it('shows only the conversation it was given', () => {
    render(<AgentBrowserWindow sessionId="s2" />)
    act(() => useBrowserToolMirror.getState().apply(notice()))
    expect(screen.queryByTestId('agent-browser-window')).toBeNull()
  })

  it('says it is waiting when it has facts but no picture yet', () => {
    render(<AgentBrowserWindow sessionId="s1" />)
    act(() => useBrowserToolMirror.getState().apply(notice({ screenshot: null })))
    expect(screen.queryByTestId('abw-frame')).toBeNull()
    expect(screen.getByTestId('abw-viewport').textContent).toContain('common:browserToolMirror.waiting')
  })
})

describe('the Cowork output tab', () => {
  const props = {
    active: null,
    onSelect: vi.fn(),
    changeCount: 0,
    additions: 0,
    deletions: 0,
    activity: { running: 0, queued: 0, finished: 0 } as never,
    presentation: 'tabs' as const,
  }

  it('offers an "Agent browser" tab only while the agent has a browser open', () => {
    const { rerender } = render(<CoworkRailToolbar {...props} />)
    expect(screen.queryByLabelText('common:rail.agentBrowser')).toBeNull()
    rerender(<CoworkRailToolbar {...props} agentBrowser />)
    expect(screen.getByLabelText('common:rail.agentBrowser')).toBeTruthy()
  })

  it('selects it like any other tab', () => {
    const onSelect = vi.fn()
    render(<CoworkRailToolbar {...props} onSelect={onSelect} agentBrowser />)
    fireEvent.click(screen.getByLabelText('common:rail.agentBrowser'))
    expect(onSelect).toHaveBeenCalledWith('browser')
  })

  it('marks it pressed when it is the open tab', () => {
    render(<CoworkRailToolbar {...props} active="browser" agentBrowser />)
    expect(screen.getByLabelText('common:rail.agentBrowser').getAttribute('aria-pressed')).toBe('true')
  })
})
