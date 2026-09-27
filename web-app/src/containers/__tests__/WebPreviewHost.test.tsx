import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useWebPreview } from '@/hooks/useWebPreview'

const { openUrl, createWebviewWindow } = vi.hoisted(() => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  createWebviewWindow: vi.fn().mockResolvedValue({ label: 'x' }),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    opener: () => ({ openUrl }),
    window: () => ({ createWebviewWindow }),
  }),
}))

import { WebPreviewHost } from '../WebPreviewHost'
import { useBrowserVerify } from '@/hooks/useBrowserVerify'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkView } from '@/hooks/useCoworkView'

describe('WebPreviewHost', () => {
  beforeEach(() => {
    openUrl.mockClear()
    createWebviewWindow.mockClear()
    useWebPreview.setState({ open: false, surface: 'side', history: [], index: -1 })
  })

  it('renders nothing when closed', () => {
    const { container } = render(<WebPreviewHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a sandboxed iframe at the current url when open', () => {
    useWebPreview.getState().openUrl('https://a.com')
    render(<WebPreviewHost />)
    const frame = screen.getByTitle('https://a.com') as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts')
    expect(frame.getAttribute('src')).toBe('https://a.com')
  })

  it('open-external delegates to opener.openUrl', () => {
    useWebPreview.getState().openUrl('https://a.com')
    render(<WebPreviewHost />)
    fireEvent.click(screen.getByTestId('wp-open-external'))
    expect(openUrl).toHaveBeenCalledWith('https://a.com')
  })

  it('pop-out creates an incognito webview window', () => {
    useWebPreview.getState().openUrl('https://a.com')
    render(<WebPreviewHost />)
    fireEvent.click(screen.getByTestId('wp-pop-out'))
    expect(createWebviewWindow).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://a.com', incognito: true })
    )
  })

  it('toggles from side to PIP', () => {
    useWebPreview.getState().openUrl('https://a.com')
    render(<WebPreviewHost />)
    fireEvent.click(screen.getByTestId('wp-surface-toggle'))
    expect(useWebPreview.getState().surface).toBe('pip')
  })

  it('offers Verify in browser only for a local app, handing it to the Cowork Preview', () => {
    useCoworkSessions.setState({ currentId: 's1' } as never)
    useWebPreview.getState().openUrl('https://a.com')
    const { unmount } = render(<WebPreviewHost />)
    expect(screen.queryByTestId('wp-verify-in-browser')).toBeNull()
    unmount()
    useWebPreview.getState().openUrl('http://localhost:5173/')
    render(<WebPreviewHost />)
    fireEvent.click(screen.getByTestId('wp-verify-in-browser'))
    expect(useBrowserVerify.getState().draftUrl).toBe('http://localhost:5173/')
    expect(useCoworkView.getState().railBySession.s1).toEqual({ kind: 'preview' })
    // The preview itself is unchanged.
    expect(useWebPreview.getState().url()).toBe('http://localhost:5173/')
  })
})
