import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, v?: Record<string, string>) => (v?.action ? `${k}:${v.action}` : k),
  }),
}))

import { BrowserToolMirror } from '../BrowserToolMirror'
import { useBrowserToolMirror } from '@/hooks/useBrowserToolMirror'

const shot = 'data:image/jpeg;base64,AAAA'

describe('BrowserToolMirror', () => {
  beforeEach(() => {
    useBrowserToolMirror.setState({ byId: {} })
    // No desktop backend in the test: attaching is a quiet no-op.
    vi.spyOn(useBrowserToolMirror.getState(), 'attach').mockResolvedValue(() => undefined)
  })

  it('renders nothing until the agent has used its browser', () => {
    render(<BrowserToolMirror sessionId="s1" />)
    expect(screen.queryByTestId('browser-tool-mirror')).toBeNull()
  })

  it('shows the address, title, last action and the picture as an image', async () => {
    render(<BrowserToolMirror sessionId="s1" />)
    act(() => {
      useBrowserToolMirror.getState().apply({
        sessionId: 's1',
        runId: 'r',
        kind: 'action',
        action: 'click e12 button "Save"',
        url: 'http://127.0.0.1:5173/form',
        title: 'Form',
        screenshot: shot,
      })
    })
    await waitFor(() => screen.getByTestId('browser-tool-mirror'))
    expect(screen.getByTestId('btm-url').textContent).toBe('http://127.0.0.1:5173/form')
    expect(screen.getByTestId('btm-title').textContent).toBe('Form')
    expect(screen.getByTestId('btm-action').textContent).toContain('click e12 button "Save"')
    const img = screen.getByTestId('btm-screenshot') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(shot)
    // The page itself is never embedded: an image, never a frame or webview.
    expect(document.querySelector('iframe, webview, object, embed')).toBeNull()
  })

  it('shows only the conversation it was given', async () => {
    useBrowserToolMirror.getState().apply({ sessionId: 's2', kind: 'action', action: 'x', url: 'http://localhost/', title: '', screenshot: null })
    render(<BrowserToolMirror sessionId="s1" />)
    expect(screen.queryByTestId('browser-tool-mirror')).toBeNull()
  })

  it('goes away when the browser closes', async () => {
    useBrowserToolMirror.getState().apply({ sessionId: 's1', kind: 'open', action: 'open', url: 'http://localhost/', title: 'T', screenshot: shot })
    render(<BrowserToolMirror sessionId="s1" />)
    expect(screen.getByTestId('browser-tool-mirror')).toBeTruthy()
    act(() => {
      useBrowserToolMirror.getState().apply({ sessionId: 's1', kind: 'closed', action: 'closed', url: '', title: '', screenshot: null })
    })
    await waitFor(() => expect(screen.queryByTestId('browser-tool-mirror')).toBeNull())
  })

  it('starts watching when mounted and stops when unmounted', async () => {
    const detach = vi.fn()
    const attach = vi.fn().mockResolvedValue(detach)
    useBrowserToolMirror.setState({ attach })
    const { unmount } = render(<BrowserToolMirror sessionId="s1" />)
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1))
    unmount()
    await waitFor(() => expect(detach).toHaveBeenCalledTimes(1))
  })
})
